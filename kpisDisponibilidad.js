// ====================================================================
// MÓDULO: DISPONIBILIDAD DE SISTEMAS CRÍTICOS & DOWNTIME
// ====================================================================

function inicializarModuloDisponibilidad() {
  const ahora = new Date();
  const elMes = document.getElementById('dispFiltroMes');
  const elAnio = document.getElementById('dispFiltroAnio');
  if (elMes) elMes.value = ahora.getMonth() + 1;
  if (elAnio) elAnio.value = ahora.getFullYear();

  cargarCatSistemas();
}

async function cargarCatSistemas() {
  try {
    const res = await fetch('/api/kpis/sistemas');
    const data = await res.json();
    const sel = document.getElementById('prIdSistema');
    if (sel && Array.isArray(data)) {
      sel.innerHTML = data.map(s => `<option value="${s.IdSistema}">${s.NombreSistema}</option>`).join('');
    }
  } catch (err) {
    console.error('Error al cargar catálogo de sistemas:', err);
  }
}

async function cargarKpisDisponibilidad() {
  const mes = document.getElementById('dispFiltroMes').value;
  const anio = document.getElementById('dispFiltroAnio').value;

  try {
    const res = await fetch(`/api/kpis/disponibilidad?mes=${mes}&anio=${anio}`);
    const data = await res.json();

    if (data.ok) {
      const grid = document.getElementById('gridSistemasDisponibilidad');
      if (grid) {
        if (!data.resumenSistemas || data.resumenSistemas.length === 0) {
          grid.innerHTML = `<div class="col-span-full p-4 text-center text-xs text-slate-500">No hay sistemas registrados.</div>`;
        } else {
          grid.innerHTML = data.resumenSistemas.map(s => {
            const pct = parseFloat(s.PorcentajeDisponibilidad);
            const colorText = pct >= 99.0 ? 'text-emerald-400' : (pct >= 95.0 ? 'text-amber-400' : 'text-rose-400');

            return `
              <div class="bg-slate-900/80 border border-slate-800 p-5 rounded-2xl space-y-2">
                <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 truncate block">${s.NombreSistema}</span>
                <h3 class="text-2xl font-extrabold ${colorText}">${pct}%</h3>
                <div class="flex justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-800/60">
                  <span>Paro: <b>${s.HorasParo} h</b></span>
                  <span>Uptime: <b>${s.HorasUptime} h</b></span>
                </div>
              </div>
            `;
          }).join('');
        }
      }

      const tbody = document.getElementById('tablaParosBody');
      if (tbody) {
        if (!data.historialParos || data.historialParos.length === 0) {
          tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-500">No se registraron tickets de Paro de Operación en el mes seleccionado.</td></tr>`;
          return;
        }

        tbody.innerHTML = data.historialParos.map(p => `
          <tr class="hover:bg-slate-800/40 transition border-b border-slate-800/40">
            <td class="p-4 font-bold text-[#F67280]">#${p.IdTicket} - ${p.NombreSistema}</td>
            <td class="p-4 text-slate-300">${new Date(p.FechaInicio).toLocaleString('es-MX')}</td>
            <td class="p-4 text-slate-300">${p.Estatus === 'Cerrado' ? new Date(p.FechaFin).toLocaleString('es-MX') : '<span class="text-amber-400 font-bold">En curso (Abierto)</span>'}</td>
            <td class="p-4 font-bold text-rose-400">${p.HorasParo} h (${p.MinutosParo} min)</td>
            <td class="p-4 text-slate-300"><span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300">${p.NombrePrioridad}</span></td>
            <td class="p-4 text-slate-400">${p.NombreSolicitante}</td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Error al cargar disponibilidades:', err);
  }
}

function abrirModalRegistroParo() { document.getElementById('modalRegistroParo')?.classList.remove('hidden'); }
function cerrarModalParo() { document.getElementById('modalRegistroParo')?.classList.add('hidden'); }

document.addEventListener('DOMContentLoaded', () => {
  const formParo = document.getElementById('formRegistroParo');
  if (formParo) {
    formParo.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usuarioLogueado = localStorage.getItem('usuarioDaker') || 'Oscar Diaz';

      const body = {
        idSistema: document.getElementById('prIdSistema').value,
        fechaInicio: document.getElementById('prFechaInicio').value,
        fechaFin: document.getElementById('prFechaFin').value,
        motivoParo: document.getElementById('prMotivo').value,
        registradoPor: usuarioLogueado
      };

      try {
        const res = await fetch('/api/kpis/disponibilidad/paro', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (res.ok) {
          cerrarModalParo();
          cargarKpisDisponibilidad();
          formParo.reset();
        }
      } catch (err) {
        console.error('Error al guardar evento de paro:', err);
      }
    });
  }
});