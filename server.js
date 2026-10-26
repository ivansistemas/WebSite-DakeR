require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// SERVIR ARCHIVOS ESTÁTICOS
app.use(express.static(__dirname));

// RUTA RAÍZ
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// FUNCIÓN AUXILIAR PARA LIMPIAR VALORES DEL .ENV
function parseEnv(value, defaultValue = '') {
  if (!value) return defaultValue;
  return value.trim().replace(/^["']|["']$/g, '');
}

// CONFIGURACIÓN DE CONEXIÓN A SQL SERVER DESDE .ENV
const configSql = {
  user: parseEnv(process.env.DB_USER, 'sa'),
  password: parseEnv(process.env.DB_PASSWORD, ''),
  server: parseEnv(process.env.DB_SERVER, '127.0.0.1'),
  database: parseEnv(process.env.DB_NAME, 'WeBdakerThera'),
  port: parseInt(parseEnv(process.env.DB_PORT, '1433'), 10),
  options: {
    encrypt: parseEnv(process.env.DB_ENCRYPT) === 'true',
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// POOL ÚNICO REUTILIZABLE
let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(configSql)
      .then(pool => {
        console.log(`✅ [SQL SERVER]: Conexión exitosa a ${configSql.server}:${configSql.port} [BD: ${configSql.database}]`);
        return pool;
      })
      .catch(err => {
        poolPromise = null;
        console.error('❌ [SQL SERVER ERROR]:', err.message);
        throw err;
      });
  }
  return poolPromise;
}

// ====================================================================
// 1. LOGIN DE USUARIO
// ====================================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('email', sql.VarChar, email)
      .input('password', sql.VarChar, password)
      .query(`
        SELECT u.IdUsuario, u.NombreCompleto, u.Email, u.Departamento, u.IdRol, u.Activo,
               ISNULL(u.modulokpi, 0) AS modulokpi,
               ISNULL(u.kpiTicket, 0) AS kpiTicket,
               r.NombreRol
        FROM dbo.Usuarios u
        LEFT JOIN dbo.Roles r ON u.IdRol = r.IdRol
        WHERE u.Email = @email AND u.Password = @password AND u.Activo = 1
      `);

    if (result.recordset.length > 0) {
      res.json({ ok: true, usuario: result.recordset[0] });
    } else {
      res.status(401).json({ ok: false, mensaje: 'Usuario o contraseña incorrectos, o cuenta inactiva.' });
    }
  } catch (error) {
    console.error('❌ [LOGIN ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error de comunicación con SQL Server: ' + error.message });
  }
});

// ====================================================================
// 2. CATÁLOGOS DE TICKETS
// ====================================================================
app.get('/api/tickets/catalogos', async (req, res) => {
  try {
    const pool = await getPool();
    const temas = await pool.request().query(`
      SELECT t.IdTema, t.NombreTema, t.IdPrioridad, t.Activo, p.NombrePrioridad, p.HorasSolucion
      FROM dbo.TemasAyuda t
      INNER JOIN dbo.PrioridadesSLA p ON t.IdPrioridad = p.IdPrioridad
      WHERE t.Activo = 1
      ORDER BY t.NombreTema ASC
    `);
    const prioridades = await pool.request().query(`SELECT IdPrioridad, NombrePrioridad, HorasSolucion FROM dbo.PrioridadesSLA ORDER BY IdPrioridad ASC`);
    const usuarios = await pool.request().query(`SELECT IdUsuario, NombreCompleto, Email FROM dbo.Usuarios WHERE Activo = 1 ORDER BY NombreCompleto ASC`);

    res.json({ temas: temas.recordset, prioridades: prioridades.recordset, usuarios: usuarios.recordset });
  } catch (error) {
    console.error('❌ [CATÁLOGOS ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al consultar catálogos.' });
  }
});

// ====================================================================
// 3. CONSULTA DE TICKETS
// ====================================================================
app.get('/api/tickets/lista', async (req, res) => {
  const { email, idRol } = req.query;
  try {
    const pool = await getPool();
    const request = pool.request();
    let query = `
      SELECT t.IdTicket, t.NombreSolicitante, t.EmailSolicitante, t.Asunto, t.Estatus, t.FechaCreacion,
             ta.NombreTema, p.NombrePrioridad, p.HorasSolucion
      FROM dbo.Tickets t
      INNER JOIN dbo.TemasAyuda ta ON t.IdTema = ta.IdTema
      INNER JOIN dbo.PrioridadesSLA p ON t.IdPrioridad = p.IdPrioridad
    `;

    if (parseInt(idRol) === 3 && email) {
      request.input('email', sql.VarChar, email);
      query += ` WHERE t.EmailSolicitante = @email`;
    }

    query += ` ORDER BY t.FechaCreacion DESC`;
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (error) {
    console.error('❌ [LISTA TICKETS ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener tickets.' });
  }
});

// ====================================================================
// 4. CREAR NUEVO TICKET (Tabla actualizada: dbo.TicketRespuestas)
// ====================================================================
app.post('/api/tickets/nuevo', async (req, res) => {
  const { nombre, email, idTema, idPrioridad, mensaje } = req.body;
  try {
    const pool = await getPool();
    const trans = new sql.Transaction(pool);
    await trans.begin();

    const reqInsert = new sql.Request(trans);
    reqInsert.input('nombre', sql.VarChar, nombre);
    reqInsert.input('email', sql.VarChar, email);
    reqInsert.input('idTema', sql.Int, idTema);
    reqInsert.input('idPrioridad', sql.Int, idPrioridad);
    reqInsert.input('asunto', sql.VarChar, mensaje.substring(0, 100));

    const result = await reqInsert.query(`
      INSERT INTO dbo.Tickets (NombreSolicitante, EmailSolicitante, IdTema, IdPrioridad, Asunto, Estatus, FechaCreacion)
      OUTPUT INSERTED.IdTicket
      VALUES (@nombre, @email, @idTema, @idPrioridad, @asunto, 'Abierto', GETDATE())
    `);

    const idTicket = result.recordset[0].IdTicket;

    const reqHilo = new sql.Request(trans);
    reqHilo.input('idTicket', sql.Int, idTicket);
    reqHilo.input('nombre', sql.VarChar, nombre);
    reqHilo.input('email', sql.VarChar, email);
    reqHilo.input('mensaje', sql.VarChar, mensaje);

    await reqHilo.query(`
      INSERT INTO dbo.TicketRespuestas (IdTicket, RemitenteNombre, RemitenteEmail, EsSoporteIT, Mensaje, FechaRegistro)
      VALUES (@idTicket, @nombre, @email, 0, @mensaje, GETDATE())
    `);

    await trans.commit();
    res.json({ ok: true, idTicket, mensaje: 'Ticket registrado con éxito.' });
  } catch (error) {
    console.error('❌ [NUEVO TICKET ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al guardar el ticket.' });
  }
});

// ====================================================================
// 5. DETALLE E HILO DE TICKET
// ====================================================================
app.get('/api/tickets/detalle/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await getPool();
    const ticketRes = await pool.request().input('id', sql.Int, id).query(`
      SELECT t.IdTicket, t.NombreSolicitante, t.EmailSolicitante, t.Estatus, t.FechaCreacion, ta.NombreTema
      FROM dbo.Tickets t
      INNER JOIN dbo.TemasAyuda ta ON t.IdTema = ta.IdTema
      WHERE t.IdTicket = @id
    `);

    const hiloRes = await pool.request().input('id', sql.Int, id).query(`
      SELECT RemitenteNombre, RemitenteEmail, EsSoporteIT, Mensaje, FechaRegistro
      FROM dbo.TicketRespuestas 
      WHERE IdTicket = @id 
      ORDER BY FechaRegistro ASC
    `);

    res.json({ ticket: ticketRes.recordset[0], hilo: hiloRes.recordset });
  } catch (error) {
    console.error('❌ [DETALLE TICKET ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al obtener detalle.' });
  }
});

// ====================================================================
// 6. RESPONDER TICKET (Tabla actualizada: dbo.TicketRespuestas)
// ====================================================================
app.post('/api/tickets/responder', async (req, res) => {
  const { idTicket, remitenteNombre, remitenteEmail, esSoporteIT, mensaje } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('idTicket', sql.Int, idTicket)
      .input('nombre', sql.VarChar, remitenteNombre)
      .input('email', sql.VarChar, remitenteEmail)
      .input('esSoporte', sql.Bit, esSoporteIT ? 1 : 0)
      .input('mensaje', sql.VarChar, mensaje)
      .query(`
        INSERT INTO dbo.TicketRespuestas (IdTicket, RemitenteNombre, RemitenteEmail, EsSoporteIT, Mensaje, FechaRegistro)
        VALUES (@idTicket, @nombre, @email, @esSoporte, @mensaje, GETDATE())
      `);

    res.json({ ok: true, mensaje: 'Respuesta registrada.' });
  } catch (error) {
    console.error('❌ [RESPONDER ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al responder ticket.' });
  }
});

// ====================================================================
// 7. CERRAR TICKET CON SOLUCIÓN (Tabla actualizada: dbo.TicketRespuestas)
// ====================================================================
app.put('/api/tickets/estatus', async (req, res) => {
  const { idTicket, estatus, solucion, remitenteNombre, remitenteEmail } = req.body;
  try {
    const pool = await getPool();
    const trans = new sql.Transaction(pool);
    await trans.begin();

    const reqUpd = new sql.Request(trans);
    reqUpd.input('idTicket', sql.Int, idTicket);
    reqUpd.input('estatus', sql.VarChar, estatus);
    await reqUpd.query(`UPDATE dbo.Tickets SET Estatus = @estatus, FechaCierre = GETDATE() WHERE IdTicket = @idTicket`);

    if (solucion) {
      const reqSol = new sql.Request(trans);
      reqSol.input('idTicket', sql.Int, idTicket);
      reqSol.input('nombre', sql.VarChar, remitenteNombre);
      reqSol.input('email', sql.VarChar, remitenteEmail);
      reqSol.input('mensaje', sql.VarChar, `[SOLUCIÓN APLICADA]: ${solucion}`);
      await reqSol.query(`
        INSERT INTO dbo.TicketRespuestas (IdTicket, RemitenteNombre, RemitenteEmail, EsSoporteIT, Mensaje, FechaRegistro)
        VALUES (@idTicket, @nombre, @email, 1, @mensaje, GETDATE())
      `);
    }

    await trans.commit();
    res.json({ ok: true, mensaje: 'Estatus actualizado.' });
  } catch (error) {
    console.error('❌ [ESTATUS ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al cambiar estatus.' });
  }
});

// ====================================================================
// 8. TEMAS Y SLAS
// ====================================================================
app.post('/api/tickets/temas', async (req, res) => {
  const { nombreTema, idPrioridad } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('nombre', sql.VarChar, nombreTema)
      .input('idPrio', sql.Int, idPrioridad)
      .query(`INSERT INTO dbo.TemasAyuda (NombreTema, IdPrioridad, Activo) VALUES (@nombre, @idPrio, 1)`);
    res.json({ ok: true, mensaje: 'Tema creado.' });
  } catch (error) {
    console.error('❌ [CREAR TEMA ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al crear tema.' });
  }
});

app.put('/api/tickets/temas/:id', async (req, res) => {
  const { id } = req.params;
  const { nombreTema, idPrioridad, activo } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .input('nombre', sql.VarChar, nombreTema)
      .input('idPrio', sql.Int, idPrioridad)
      .input('activo', sql.Bit, activo ? 1 : 0)
      .query(`UPDATE dbo.TemasAyuda SET NombreTema = @nombre, IdPrioridad = @idPrio, Activo = @activo WHERE IdTema = @id`);
    res.json({ ok: true, mensaje: 'Tema actualizado.' });
  } catch (error) {
    console.error('❌ [ACTUALIZAR TEMA ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar tema.' });
  }
});

// ====================================================================
// 9. GESTIÓN DE USUARIOS
// ====================================================================
app.get('/api/admin/usuarios', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT u.IdUsuario, u.NombreCompleto, u.Email, u.Departamento, u.IdRol, u.Activo,
             ISNULL(u.modulokpi, 0) AS modulokpi,
             ISNULL(u.kpiTicket, 0) AS kpiTicket,
             r.NombreRol
      FROM dbo.Usuarios u
      LEFT JOIN dbo.Roles r ON u.IdRol = r.IdRol
      ORDER BY u.NombreCompleto ASC
    `);
    res.json(result.recordset);
  } catch (error) {
    console.error('❌ [OBTENER USUARIOS ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al consultar usuarios.' });
  }
});

app.post('/api/admin/usuarios', async (req, res) => {
  const { nombreCompleto, email, password, departamento, idRol, modulokpi, kpiTicket } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('nombre', sql.VarChar, nombreCompleto)
      .input('email', sql.VarChar, email)
      .input('pass', sql.VarChar, password || '123456')
      .input('depto', sql.VarChar, departamento)
      .input('idRol', sql.Int, idRol)
      .input('modKpi', sql.Bit, modulokpi ? 1 : 0)
      .input('kpiTck', sql.Bit, kpiTicket ? 1 : 0)
      .query(`
        INSERT INTO dbo.Usuarios (NombreCompleto, Email, Password, Departamento, IdRol, Activo, modulokpi, kpiTicket)
        VALUES (@nombre, @email, @pass, @depto, @idRol, 1, @modKpi, @kpiTck)
      `);
    res.json({ ok: true, mensaje: 'Usuario registrado correctamente.' });
  } catch (error) {
    console.error('❌ [CREAR USUARIO ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al crear usuario.' });
  }
});

app.put('/api/admin/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { nombreCompleto, email, password, departamento, idRol, activo, modulokpi, kpiTicket } = req.body;
  try {
    const pool = await getPool();
    let query = `
      UPDATE dbo.Usuarios 
      SET NombreCompleto = @nombre, Email = @email, Departamento = @depto, IdRol = @idRol, 
          Activo = @activo, modulokpi = @modKpi, kpiTicket = @kpiTck
    `;
    if (password && password.trim() !== '') {
      query += `, Password = @pass`;
    }
    query += ` WHERE IdUsuario = @id`;

    const reqSql = pool.request()
      .input('id', sql.Int, id)
      .input('nombre', sql.VarChar, nombreCompleto)
      .input('email', sql.VarChar, email)
      .input('depto', sql.VarChar, departamento)
      .input('idRol', sql.Int, idRol)
      .input('activo', sql.Bit, activo ? 1 : 0)
      .input('modKpi', sql.Bit, modulokpi ? 1 : 0)
      .input('kpiTck', sql.Bit, kpiTicket ? 1 : 0);

    if (password && password.trim() !== '') {
      reqSql.input('pass', sql.VarChar, password);
    }

    await reqSql.query(query);
    res.json({ ok: true, mensaje: 'Usuario actualizado correctamente.' });
  } catch (error) {
    console.error('❌ [ACTUALIZAR USUARIO ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al actualizar usuario.' });
  }
});

// ====================================================================
// 10. ROLES
// ====================================================================
app.get('/api/admin/roles', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT r.IdRol, r.NombreRol, 
             (SELECT COUNT(*) FROM dbo.Usuarios u WHERE u.IdRol = r.IdRol AND u.Activo = 1) AS TotalUsuarios
      FROM dbo.Roles r
      ORDER BY r.IdRol ASC
    `);
    res.json(result.recordset);
  } catch (error) {
    console.error('❌ [OBTENER ROLES ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al consultar roles.' });
  }
});

app.post('/api/admin/roles', async (req, res) => {
  const { nombreRol } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('nombre', sql.VarChar, nombreRol)
      .query(`INSERT INTO dbo.Roles (NombreRol) VALUES (@nombre)`);
    res.json({ ok: true, mensaje: 'Rol registrado correctamente.' });
  } catch (error) {
    console.error('❌ [CREAR ROL ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al crear rol.' });
  }
});

// ====================================================================
// 13. MÓDULO DE KPIS: MÉTRICOS DE TICKETS POR PERÍODO Y CRITICIDAD (SLA)
// ====================================================================
app.get('/api/kpis/tickets', async (req, res) => {
  const { fechaInicio, fechaFin } = req.query;
  try {
    const pool = await getPool();
    const request = pool.request();

    let query = `
      SELECT 
        t.IdTicket,
        t.Asunto,
        t.NombreSolicitante,
        t.EmailSolicitante,
        t.Estatus,
        t.FechaCreacion,
        t.FechaCierre,
        p.IdPrioridad,
        p.NombrePrioridad,
        p.HorasSolucion,
        ta.NombreTema,
        DATEDIFF(HOUR, t.FechaCreacion, ISNULL(t.FechaCierre, GETDATE())) AS HorasTranscurridas,
        CASE 
          WHEN ISNULL(t.FechaCierre, GETDATE()) <= DATEADD(HOUR, p.HorasSolucion, t.FechaCreacion) THEN 'Logrado'
          ELSE 'Incumplido'
        END AS EstadoSLA
      FROM dbo.Tickets t
      INNER JOIN dbo.PrioridadesSLA p ON t.IdPrioridad = p.IdPrioridad
      INNER JOIN dbo.TemasAyuda ta ON t.IdTema = ta.IdTema
      WHERE 1=1
    `;

    if (fechaInicio) {
      request.input('fInicio', sql.VarChar, `${fechaInicio} 00:00:00`);
      query += ` AND t.FechaCreacion >= @fInicio`;
    }
    if (fechaFin) {
      request.input('fFin', sql.VarChar, `${fechaFin} 23:59:59`);
      query += ` AND t.FechaCreacion <= @fFin`;
    }

    query += ` ORDER BY t.FechaCreacion DESC`;

    const result = await request.query(query);
    const tickets = result.recordset;

    const total = tickets.length;
    const logrados = tickets.filter(t => t.EstadoSLA === 'Logrado').length;
    const incumplidos = tickets.filter(t => t.EstadoSLA === 'Incumplido').length;
    const porcentajeCumplimiento = total > 0 ? ((logrados / total) * 100).toFixed(1) : 0;

    res.json({
      ok: true,
      resumen: {
        total,
        logrados,
        incumplidos,
        porcentajeCumplimiento
      },
      tickets
    });
  } catch (error) {
    console.error('❌ [KPIS TICKETS ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al consultar métricas de tickets.' });
  }
});

// ====================================================================
// N3. KPIS: DISPONIBILIDAD DE SISTEMAS CRÍTICOS Y BASELINE MENSUAL
// ====================================================================

// Obtener catálogo de sistemas críticos
app.get('/api/kpis/sistemas', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT IdSistema, NombreSistema, Descripcion FROM dbo.SistemasCriticos WHERE Activo = 1 ORDER BY NombreSistema ASC
    `);
    res.json(result.recordset);
  } catch (error) {
    console.error('❌ [SISTEMAS CRÍTICOS ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al consultar sistemas críticos.' });
  }
});

// Consultar Disponibilidad (Uptime) filtrada por Mes y Año
app.get('/api/kpis/disponibilidad', async (req, res) => {
  const mes = parseInt(req.query.mes || (new Date().getMonth() + 1));
  const anio = parseInt(req.query.anio || new Date().getFullYear());

  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('mes', sql.Int, mes);
    request.input('anio', sql.Int, anio);

    // Consulta de disponibilidad agregada por sistema
    const result = await request.query(`
      WITH ParosMes AS (
        SELECT 
          IdSistema,
          ISNULL(SUM(DATEDIFF(MINUTE, FechaInicio, FechaFin)), 0) / 60.0 AS HorasParoTotal
        FROM dbo.RegistroParos
        WHERE MONTH(FechaInicio) = @mes AND YEAR(FechaInicio) = @anio
        GROUP BY IdSistema
      )
      SELECT 
        s.IdSistema,
        s.NombreSistema,
        s.HorasOperativasMes AS HorasTotales,
        ISNULL(p.HorasParoTotal, 0) AS HorasParo,
        (s.HorasOperativasMes - ISNULL(p.HorasParoTotal, 0)) AS HorasUptime,
        CAST(
          ((s.HorasOperativasMes - ISNULL(p.HorasParoTotal, 0)) * 100.0 / s.HorasOperativasMes) 
          AS DECIMAL(5,2)
        ) AS PorcentajeDisponibilidad
      FROM dbo.SistemasCriticos s
      LEFT JOIN ParosMes p ON s.IdSistema = p.IdSistema
      WHERE s.Activo = 1
      ORDER BY s.NombreSistema ASC
    `);

    // Detalle de eventos de paro del mes
    const detalleParos = await request.query(`
      SELECT p.IdParo, s.NombreSistema, p.FechaInicio, p.FechaFin, p.MinutosParo, p.HorasParo, p.MotivoParo, p.ImpactoOperativo, p.RegistradoPor
      FROM dbo.RegistroParos p
      INNER JOIN dbo.SistemasCriticos s ON p.IdSistema = s.IdSistema
      WHERE MONTH(p.FechaInicio) = @mes AND YEAR(p.FechaInicio) = @anio
      ORDER BY p.FechaInicio DESC
    `);

    res.json({
      ok: true,
      mes,
      anio,
      resumenSistemas: result.recordset,
      historialParos: detalleParos.recordset
    });
  } catch (error) {
    console.error('❌ [DISPONIBILIDAD ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al consultar disponibilidad de sistemas.' });
  }
});

// Registrar un evento de paro no programado (Downtime)
app.post('/api/kpis/disponibilidad/paro', async (req, res) => {
  const { idSistema, fechaInicio, fechaFin, motivoParo, impactoOperativo, registradoPor } = req.body;
  try {
    const pool = await getPool();
    await pool.request()
      .input('idSistema', sql.Int, idSistema)
      .input('fInicio', sql.DateTime, fechaInicio)
      .input('fFin', sql.DateTime, fechaFin)
      .input('motivo', sql.VarChar, motivoParo)
      .input('impacto', sql.VarChar, impactoOperativo || 'Afectación operativa parcial')
      .input('usuario', sql.VarChar, registradoPor)
      .query(`
        INSERT INTO dbo.RegistroParos (IdSistema, FechaInicio, FechaFin, MotivoParo, ImpactoOperativo, RegistradoPor)
        VALUES (@idSistema, @fInicio, @fFin, @motivo, @impacto, @usuario)
      `);

    res.json({ ok: true, mensaje: 'Evento de paro registrado correctamente.' });
  } catch (error) {
    console.error('❌ [REGISTRO PARO ERROR]:', error.message);
    res.status(500).json({ ok: false, mensaje: 'Error al registrar evento de paro.' });
  }
});

// INICIA EL SERVIDOR
app.listen(PORT, async () => {
  console.log(`🚀 Servidor Therapedic OS escuchando en http://localhost:${PORT}`);
  try {
    await getPool();
  } catch (e) {
    console.log('⚠️ Verifica que las variables del archivo .env coincidan con tu servidor SQL.');
  }
});