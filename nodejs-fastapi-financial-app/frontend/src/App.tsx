import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  BarController,
  LineController,
  DoughnutController,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import './App.css'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  BarController,
  LineController,
  DoughnutController,
  Title,
  Tooltip,
  Legend,
)

interface Bolletta {
  file_path: string
  file_name: string
  fornitore: string
  numero_fattura: string
  codice_fornitura: string
  codice_pod: string
  cliente_nome: string
  indirizzo_fatturazione: string
  data_fattura: string | null
  periodo_inizio: string | null
  periodo_fine: string | null
  data_scadenza_pagamento: string | null
  data_scadenza_offerta: string | null
  importo_totale_da_pagare_eur: number | string | null
  // campi specifici luce
  potenza_impegnata_kw?: number | string | null
  consumo_fatturato_kwh?: number | null
  consumo_annuo_kwh?: number | null
  // campi specifici gas
  categoria_uso?: string | null
  matricola_contatore?: string | null
  consumo_fatturato_effettivo_smc?: number | string | null
  consumo_fatturato_stimato_smc?: number | string | null
  consumo_annuo_stimato_smc?: number | string | null
  nome_offerta: string | null
  metodo_pagamento: string | null
  mercato: string | null
  tipologia_cliente: string | null
}

interface Voce {
  file_path: string
  fornitore: string
  numero_fattura: string
  data_fattura: string | null
  voce_ordine: number | null
  descrizione: string | null
  importo_eur: number | string | null
  quantita: string | null
}

interface ApiResponse {
  header: Bolletta[]
  dettaglio: Voce[]
  generated_at: string
}

interface BustaPaga {
  file_path: string
  file_name: string
  datore_lavoro: string
  azienda: string | null
  dipendente_nome: string | null
  mese_numero: number | null
  anno: number | null
  periodo_paga: string | null
  periodo_data: string | null
  ore_lavorate: number | string | null
  ore_smart_working: number | string | null
  ore_straordinarie: number | string | null
  ore_ferie_residue: number | string | null
  ore_permessi_residui: number | string | null
  giorni_lavorati: number | null
  giorni_retribuiti: number | null
  retribuzione_mensile_eur: number | string | null
  totale_competenze_eur: number | string | null
  totale_ritenute_eur: number | string | null
  netto_in_busta_eur: number | string | null
  irpef_netta_mensile_eur: number | string | null
  addizionale_regionale_eur: number | string | null
  addizionale_comunale_eur: number | string | null
  tfr_mese_eur: number | string | null
}

interface VocePaga {
  file_path: string
  anno: number | null
  mese_numero: number | null
  voce_ordine: number | null
  codice: string | null
  descrizione: string | null
  ore_o_giorni: number | string | null
  dato_base: number | string | null
  importo_figurativo_eur: number | string | null
  ritenuta_eur: number | string | null
  competenza_eur: number | string | null
}

interface StipendioResponse {
  header: BustaPaga[]
  dettaglio: VocePaga[]
  generated_at: string
}

const PALETTE = ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff']

const num = (v: number | string | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === 'number' ? v : parseFloat(v) || 0

const eur = (v: number): string =>
  new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(v)

const kwhFmt = (v: number): string => new Intl.NumberFormat('it-IT').format(Math.round(v))

const smcFmt = (v: number): string =>
  new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(v)

const dateFmt = (s: string | null): string =>
  s
    ? new Date(s).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—'

const monthLabel = (key: string): string => {
  const [y, m] = key.split('-')
  return `${m}/${y.slice(2)}`
}

const MESI = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
]

// Etichetta compatta per il trend stipendio: '11/26' per i mesi ordinari,
// 'Tred 25' / 'Quatt 25' per tredicesima e quattordicesima (mese 13/14).
const stipendioPeriodoLabel = (key: string): string => {
  const [y, m] = key.split('-')
  const mi = parseInt(m, 10)
  if (mi === 13) return `Tred ${y.slice(2)}`
  if (mi === 14) return `Quatt ${y.slice(2)}`
  return `${m}/${y.slice(2)}`
}

const oreFmt = (v: number): string =>
  new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(v)

type Tipo = 'luce' | 'gas' | 'stipendio'

interface TipoConfig {
  icona: string
  navLabel: string
  titolo: string
  unita: string
  unitaPrezzo: string
  fonte: string
  consumo: (b: Bolletta) => number
  // Solo per il gas: scissione del consumo in effettivo/stimato (per il trend)
  effettivo?: (b: Bolletta) => number
  stimato?: (b: Bolletta) => number
  consumoAnnuo: (b: Bolletta) => string
  fmt: (v: number) => string
}

// Config per tipo: la dashboard è unica, parametrizzata su luce/gas.
// Per il gas il consumo fatturato del periodo è effettivo + stimato (dipende
// dalla tipologia di lettura del contatore, di solito è valorizzato solo uno).
const CONFIG: Record<'luce' | 'gas', TipoConfig> = {
  luce: {
    icona: '⚡',
    navLabel: 'Luce',
    titolo: 'Dashboard Bollette Luce',
    unita: 'kWh',
    unitaPrezzo: '€/kWh',
    fonte: 'workspace.cur.bollette_luce_header / _dettaglio',
    consumo: (b) => num(b.consumo_fatturato_kwh),
    consumoAnnuo: (b) =>
      b.consumo_annuo_kwh ? `${kwhFmt(num(b.consumo_annuo_kwh))} kWh` : '—',
    fmt: kwhFmt,
  },
  gas: {
    icona: '🔥',
    navLabel: 'Gas',
    titolo: 'Dashboard Bollette Gas',
    unita: 'Smc',
    unitaPrezzo: '€/Smc',
    fonte: 'workspace.cur.bollette_gas_header / _dettaglio',
    consumo: (b) =>
      num(b.consumo_fatturato_effettivo_smc) + num(b.consumo_fatturato_stimato_smc),
    effettivo: (b) => num(b.consumo_fatturato_effettivo_smc),
    stimato: (b) => num(b.consumo_fatturato_stimato_smc),
    consumoAnnuo: (b) =>
      b.consumo_annuo_stimato_smc ? `${smcFmt(num(b.consumo_annuo_stimato_smc))} Smc` : '—',
    fmt: smcFmt,
  },
}

function Chip({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean
  color?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`chip${active ? ' chip-active' : ''}`}
      style={active && color ? { borderColor: color, color: color } : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Dashboard({ tipo }: { tipo: 'luce' | 'gas' }) {
  const cfg = CONFIG[tipo]
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selFornitori, setSelFornitori] = useState<string[]>([])
  const [selAnni, setSelAnni] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = (refresh = false) => {
    setLoading(true)
    setError(null)
    fetch(`/api/bollette?tipo=${tipo}${refresh ? '&refresh=true' : ''}`)
      .then((r) => {
        if (!r.ok) throw new Error(`API error ${r.status}`)
        return r.json()
      })
      .then((json: ApiResponse) => {
        setData(json)
        setLoading(false)
      })
      .catch((e) => {
        console.error('Error:', e)
        setError(String(e))
        setLoading(false)
      })
  }

  useEffect(() => {
    load()
  }, [])

  const fornitori = useMemo(
    () => [...new Set((data?.header ?? []).map((b) => b.fornitore))].sort(),
    [data],
  )

  const anni = useMemo(
    () =>
      [...new Set((data?.header ?? []).map((b) => (b.periodo_inizio || b.data_fattura || '').slice(0, 4)))]
        .filter((a) => a.length === 4)
        .sort(),
    [data],
  )

  const colorFor = (name: string): string =>
    PALETTE[fornitori.indexOf(name) % PALETTE.length]

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  }

  const filtered = useMemo(
    () =>
      (data?.header ?? []).filter(
        (b) =>
          (selFornitori.length === 0 || selFornitori.includes(b.fornitore)) &&
          (selAnni.length === 0 ||
            selAnni.includes((b.periodo_inizio || b.data_fattura || '').slice(0, 4))),
      ),
    [data, selFornitori, selAnni],
  )

  const filteredPaths = useMemo(() => new Set(filtered.map((b) => b.file_path)), [filtered])

  const filteredDetail = useMemo(
    () => (data?.dettaglio ?? []).filter((v) => filteredPaths.has(v.file_path)),
    [data, filteredPaths],
  )

  const kpis = useMemo(() => {
    const totEur = filtered.reduce((s, b) => s + num(b.importo_totale_da_pagare_eur), 0)
    const totConsumo = filtered.reduce((s, b) => s + cfg.consumo(b), 0)
    return {
      totEur,
      totConsumo,
      n: filtered.length,
      avgPrice: totConsumo > 0 ? totEur / totConsumo : null,
      avgBolletta: filtered.length > 0 ? totEur / filtered.length : null,
    }
  }, [filtered])

  const months = useMemo(() => {
    const m = new Map<
      string,
      { eur: number; consumo: number; effettivo: number; stimato: number }
    >()
    filtered.forEach((b) => {
      const key = (b.periodo_inizio || b.data_fattura || '').slice(0, 7)
      if (!key) return
      const cur = m.get(key) || { eur: 0, consumo: 0, effettivo: 0, stimato: 0 }
      cur.eur += num(b.importo_totale_da_pagare_eur)
      cur.consumo += cfg.consumo(b)
      // Per il gas tiene traccia separatamente di effettivo e stimato;
      // per la luce vale l'intero consumo come "effettivo" e nessuno stimato.
      cur.effettivo += cfg.effettivo ? cfg.effettivo(b) : cfg.consumo(b)
      cur.stimato += cfg.stimato ? cfg.stimato(b) : 0
      m.set(key, cur)
    })
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered, cfg])

  const perFornitore = useMemo(
    () =>
      fornitori
        .map((f) => ({
          name: f,
          value: filtered
            .filter((b) => b.fornitore === f)
            .reduce((s, b) => s + num(b.importo_totale_da_pagare_eur), 0),
        }))
        .filter((d) => d.value > 0),
    [filtered, fornitori],
  )

  const topVoci = useMemo(() => {
    const m = new Map<string, number>()
    filteredDetail.forEach((v) => {
      const key = v.descrizione || '(senza descrizione)'
      m.set(key, (m.get(key) || 0) + num(v.importo_eur))
    })
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, value]) => ({ label, value }))
  }, [filteredDetail])

  const vociPerFattura = (filePath: string): Voce[] =>
    (data?.dettaglio ?? [])
      .filter((v) => v.file_path === filePath)
      .sort((a, b) => (a.voce_ordine ?? 0) - (b.voce_ordine ?? 0))

  // Se il tipo distingue effettivo/stimato (gas) il trend mostra due linee:
  // effettivo in continua, stimato in tratteggio. Altrimenti una linea unica.
  const consumiDatasets = cfg.stimato
    ? [
        {
          type: 'line' as const,
          label: `Consumo effettivo (${cfg.unita})`,
          data: months.map(([, v]) => v.effettivo),
          borderColor: '#ff6384',
          backgroundColor: '#ff6384',
          yAxisID: 'y1',
          tension: 0.3,
          pointRadius: 3,
        },
        {
          type: 'line' as const,
          label: `Consumo stimato (${cfg.unita})`,
          data: months.map(([, v]) => v.stimato),
          borderColor: '#ff9f40',
          backgroundColor: '#ff9f40',
          yAxisID: 'y1',
          tension: 0.3,
          pointRadius: 3,
          borderDash: [6, 4],
        },
      ]
    : [
        {
          type: 'line' as const,
          label: `Consumo (${cfg.unita})`,
          data: months.map(([, v]) => v.consumo),
          borderColor: '#ff6384',
          backgroundColor: '#ff6384',
          yAxisID: 'y1',
          tension: 0.3,
          pointRadius: 3,
        },
      ]

  const trendData = {
    labels: months.map(([k]) => monthLabel(k)),
    datasets: [
      {
        type: 'bar' as const,
        label: 'Importo (€)',
        data: months.map(([, v]) => v.eur),
        backgroundColor: 'rgba(54, 162, 235, 0.7)',
        yAxisID: 'y',
      },
      ...consumiDatasets,
    ],
  }

  const trendOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'top' as const },
      tooltip: {
        callbacks: {
          label: (
            ctx: { dataset: { label?: string }; datasetIndex: number; parsed: { y: number } },
          ) =>
            ` ${ctx.dataset.label ?? ''}: ${
              ctx.datasetIndex === 0 ? eur(ctx.parsed.y) : `${cfg.fmt(ctx.parsed.y)} ${cfg.unita}`
            }`,
        },
      },
    },
    scales: {
      y: {
        type: 'linear' as const,
        position: 'left' as const,
        title: { display: true, text: 'Importo (€)' },
        beginAtZero: true,
      },
      y1: {
        type: 'linear' as const,
        position: 'right' as const,
        title: { display: true, text: `Consumo (${cfg.unita})` },
        beginAtZero: true,
        grid: { drawOnChartArea: false },
      },
    },
  }

  const fornitoriData = {
    labels: perFornitore.map((d) => d.name),
    datasets: [
      {
        data: perFornitore.map((d) => d.value),
        backgroundColor: perFornitore.map((d) => colorFor(d.name)),
        borderWidth: 1,
      },
    ],
  }

  const vociData = {
    labels: topVoci.map((v) => v.label),
    datasets: [
      {
        label: 'Totale (€)',
        data: topVoci.map((v) => v.value),
        backgroundColor: 'rgba(153, 102, 255, 0.7)',
      },
    ],
  }

  const vociOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { x: number } }) => ` ${eur(ctx.parsed.x)}`,
        },
      },
    },
    scales: {
      x: { beginAtZero: true, title: { display: true, text: 'Totale (€)' } },
    },
  }

  const sortedBollette = useMemo(
    () => [...filtered].sort((a, b) => (b.data_fattura || '').localeCompare(a.data_fattura || '')),
    [filtered],
  )

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>
            {cfg.icona} {cfg.titolo}
          </h1>
          <p className="subtitle">
            {loading
              ? 'Caricamento...'
              : `${filtered.length} bollette · ${filteredDetail.length} voci di costo`}
          </p>
        </div>
        <button className="refresh" onClick={() => load(true)} disabled={loading}>
          ↻ Aggiorna
        </button>
      </header>

      {error && (
        <div className="error">
          Errore nel caricamento dati: {error}
        </div>
      )}

      {loading && !data ? (
        <div className="loading">Caricamento bollette da Unity Catalog…</div>
      ) : (
        <>
          <section className="filters">
            <div className="filter-group">
              <span className="filter-label">Fornitore</span>
              {fornitori.map((f) => (
                <Chip
                  key={f}
                  active={selFornitori.includes(f)}
                  color={colorFor(f)}
                  onClick={() => toggle(selFornitori, setSelFornitori, f)}
                >
                  {f}
                </Chip>
              ))}
              {selFornitori.length > 0 && (
                <button className="clear" onClick={() => setSelFornitori([])}>
                  ✕
                </button>
              )}
            </div>
            <div className="filter-group">
              <span className="filter-label">Anno</span>
              {anni.map((a) => (
                <Chip
                  key={a}
                  active={selAnni.includes(a)}
                  onClick={() => toggle(selAnni, setSelAnni, a)}
                >
                  {a}
                </Chip>
              ))}
              {selAnni.length > 0 && (
                <button className="clear" onClick={() => setSelAnni([])}>
                  ✕
                </button>
              )}
            </div>
          </section>

          <section className="kpis">
            <div className="kpi">
              <span className="kpi-label">Spesa totale</span>
              <span className="kpi-value">{eur(kpis.totEur)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Consumo totale</span>
              <span className="kpi-value">
                {cfg.fmt(kpis.totConsumo)} {cfg.unita}
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Prezzo medio</span>
              <span className="kpi-value">
                {kpis.avgPrice !== null ? `${kpis.avgPrice.toFixed(3)} ${cfg.unitaPrezzo}` : '—'}
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Bollette</span>
              <span className="kpi-value">{kpis.n}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Spesa media</span>
              <span className="kpi-value">{kpis.avgBolletta !== null ? eur(kpis.avgBolletta) : '—'}</span>
            </div>
          </section>

          <section className="grid">
            <div className="card card-wide">
              <h3>Trend mensile — importo e consumo</h3>
              <div className="chart-container">
                <Bar data={trendData} options={trendOptions} />
              </div>
            </div>
            <div className="card">
              <h3>Spesa per fornitore</h3>
              <div className="chart-container">
                {perFornitore.length > 0 ? <Doughnut data={fornitoriData} /> : <p className="empty">Nessun dato</p>}
              </div>
            </div>
            <div className="card">
              <h3>Top voci di costo</h3>
              <div className="chart-container">
                {topVoci.length > 0 ? <Bar data={vociData} options={vociOptions} /> : <p className="empty">Nessun dato</p>}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Bollette <span className="hint">(clicca una riga per voci di costo e dettagli)</span></h3>
            <div className="table-wrapper">
              <table className="bollette-table">
                <thead>
                  <tr>
                    <th>Fornitore</th>
                    <th>Fattura</th>
                    <th>Data</th>
                    <th>Periodo</th>
                    <th className="right">{cfg.unita}</th>
                    <th className="right">{cfg.unitaPrezzo}</th>
                    <th className="right">Importo</th>
                    <th>Scadenza</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedBollette.map((b) => {
                    const consumo = cfg.consumo(b)
                    const prezzo = consumo > 0
                      ? num(b.importo_totale_da_pagare_eur) / consumo
                      : null
                    const isOpen = expanded === b.file_path
                    return (
                      <Fragment key={b.file_path}>
                        <tr
                          className={`row${isOpen ? ' row-open' : ''}`}
                          onClick={() => setExpanded(isOpen ? null : b.file_path)}
                        >
                          <td>
                            <span className="badge" style={{ background: colorFor(b.fornitore) }}>
                              {b.fornitore}
                            </span>
                          </td>
                          <td>{b.numero_fattura}</td>
                          <td>{dateFmt(b.data_fattura)}</td>
                          <td>
                            {dateFmt(b.periodo_inizio)} → {dateFmt(b.periodo_fine)}
                          </td>
                          <td className="right">{consumo > 0 ? cfg.fmt(consumo) : '—'}</td>
                          <td className="right">{prezzo !== null ? prezzo.toFixed(3) : '—'}</td>
                          <td className="right strong">{eur(num(b.importo_totale_da_pagare_eur))}</td>
                          <td>{dateFmt(b.data_scadenza_pagamento)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="detail-row">
                            <td colSpan={8}>
                              <div className="detail">
                                <div className="meta-grid">
                                  <div><b>Cliente:</b> {b.cliente_nome || '—'}</div>
                                  <div><b>POD:</b> {b.codice_pod || '—'}</div>
                                  <div><b>Fornitura:</b> {b.codice_fornitura || '—'}</div>
                                  {tipo === 'luce' && (
                                    <div><b>Potenza:</b> {b.potenza_impegnata_kw ? `${num(b.potenza_impegnata_kw)} kW` : '—'}</div>
                                  )}
                                  {tipo === 'gas' && (
                                    <>
                                      <div><b>Categoria uso:</b> {b.categoria_uso || '—'}</div>
                                      <div><b>Matricola contatore:</b> {b.matricola_contatore || '—'}</div>
                                    </>
                                  )}
                                  <div><b>Offerta:</b> {b.nome_offerta || '—'}</div>
                                  <div><b>Scadenza offerta:</b> {dateFmt(b.data_scadenza_offerta)}</div>
                                  <div><b>Pagamento:</b> {b.metodo_pagamento || '—'}</div>
                                  <div><b>Mercato:</b> {b.mercato || '—'}</div>
                                  <div><b>Consumo annuo{tipo === 'gas' ? ' stimato' : ''}:</b> {cfg.consumoAnnuo(b)}</div>
                                  <div><b>File:</b> {b.file_name || '—'}</div>
                                </div>
                                <table className="voci-table">
                                  <thead>
                                    <tr>
                                      <th>#</th>
                                      <th>Voce di costo</th>
                                      <th>Quantità</th>
                                      <th className="right">Importo</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {vociPerFattura(b.file_path).map((v) => (
                                      <tr key={`${b.file_path}-${v.voce_ordine}`}>
                                        <td>{v.voce_ordine}</td>
                                        <td>{v.descrizione || '—'}</td>
                                        <td>{v.quantita || '—'}</td>
                                        <td className="right">{eur(num(v.importo_eur))}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="footer">
            Fonte: Unity Catalog — {cfg.fonte}
            {data?.generated_at ? ` · aggiornato ${new Date(data.generated_at).toLocaleString('it-IT')}` : ''}
          </footer>
        </>
      )}
    </div>
  )
}

function StipendioDashboard() {
  const [data, setData] = useState<StipendioResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selAnni, setSelAnni] = useState<string[]>([])
  const [vociMode, setVociMode] = useState<'competenze' | 'ritenute'>('competenze')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = (refresh = false) => {
    setLoading(true)
    setError(null)
    fetch(`/api/bollette?tipo=stipendio${refresh ? '&refresh=true' : ''}`)
      .then((r) => {
        if (!r.ok) throw new Error(`API error ${r.status}`)
        return r.json()
      })
      .then((json: StipendioResponse) => {
        setData(json)
        setLoading(false)
      })
      .catch((e) => {
        console.error('Error:', e)
        setError(String(e))
        setLoading(false)
      })
  }

  useEffect(() => {
    load()
  }, [])

  const anni = useMemo(
    () => [...new Set((data?.header ?? []).map((b) => String(b.anno)))].sort(),
    [data],
  )

  const toggleAnno = (a: string) =>
    setSelAnni(selAnni.includes(a) ? selAnni.filter((v) => v !== a) : [...selAnni, a])

  const filtered = useMemo(
    () =>
      (data?.header ?? []).filter(
        (b) => selAnni.length === 0 || selAnni.includes(String(b.anno)),
      ),
    [data, selAnni],
  )

  const filteredPaths = useMemo(() => new Set(filtered.map((b) => b.file_path)), [filtered])

  const filteredDetail = useMemo(
    () => (data?.dettaglio ?? []).filter((v) => filteredPaths.has(v.file_path)),
    [data, filteredPaths],
  )

  const kpis = useMemo(() => {
    const netto = filtered.reduce((s, b) => s + num(b.netto_in_busta_eur), 0)
    const ritenute = filtered.reduce((s, b) => s + num(b.totale_ritenute_eur), 0)
    const competenze = filtered.reduce((s, b) => s + num(b.totale_competenze_eur), 0)
    return {
      netto,
      ritenute,
      competenze,
      n: filtered.length,
      nettoMedio: filtered.length > 0 ? netto / filtered.length : null,
    }
  }, [filtered])

  // Un punto per periodo (anno-mese); mese 13/14 = tredicesima/quattordicesima.
  const mesi = useMemo(() => {
    const m = new Map<string, { netto: number; ore: number }>()
    filtered.forEach((b) => {
      if (b.anno === null || b.mese_numero === null) return
      const key = `${b.anno}-${String(b.mese_numero).padStart(2, '0')}`
      const cur = m.get(key) || { netto: 0, ore: 0 }
      cur.netto += num(b.netto_in_busta_eur)
      cur.ore += num(b.ore_lavorate)
      m.set(key, cur)
    })
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  // Composizione della busta: netto e dettaglio ritenute dall'header.
  const composizione = useMemo(() => {
    const irpef = filtered.reduce((s, b) => s + num(b.irpef_netta_mensile_eur), 0)
    const reg = filtered.reduce((s, b) => s + num(b.addizionale_regionale_eur), 0)
    const com = filtered.reduce((s, b) => s + num(b.addizionale_comunale_eur), 0)
    const altre = Math.max(0, kpis.ritenute - irpef - reg - com)
    return [
      { name: 'Netto in busta', value: kpis.netto },
      { name: 'IRPEF', value: irpef },
      { name: 'Addiz. regionale', value: reg },
      { name: 'Addiz. comunale', value: com },
      { name: 'Altre ritenute', value: altre },
    ].filter((d) => d.value > 0)
  }, [filtered, kpis])

  const topVoci = useMemo(() => {
    const m = new Map<string, number>()
    filteredDetail.forEach((v) => {
      const key = v.descrizione || '(senza descrizione)'
      const valore = num(vociMode === 'competenze' ? v.competenza_eur : v.ritenuta_eur)
      m.set(key, (m.get(key) || 0) + valore)
    })
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, value]) => ({ label, value }))
  }, [filteredDetail, vociMode])

  const vociPerBusta = (filePath: string): VocePaga[] =>
    (data?.dettaglio ?? [])
      .filter((v) => v.file_path === filePath)
      .sort((a, b) => (a.voce_ordine ?? 0) - (b.voce_ordine ?? 0))

  const trendData = {
    labels: mesi.map(([k]) => stipendioPeriodoLabel(k)),
    datasets: [
      {
        type: 'bar' as const,
        label: 'Netto in busta (€)',
        data: mesi.map(([, v]) => v.netto),
        backgroundColor: 'rgba(54, 162, 235, 0.7)',
        yAxisID: 'y',
      },
      {
        type: 'line' as const,
        label: 'Ore lavorate (h)',
        data: mesi.map(([, v]) => v.ore),
        borderColor: '#4bc0c0',
        backgroundColor: '#4bc0c0',
        yAxisID: 'y1',
        tension: 0.3,
        pointRadius: 3,
      },
    ],
  }

  const trendOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'top' as const },
      tooltip: {
        callbacks: {
          label: (
            ctx: { dataset: { label?: string }; datasetIndex: number; parsed: { y: number } },
          ) =>
            ` ${ctx.dataset.label ?? ''}: ${
              ctx.datasetIndex === 0 ? eur(ctx.parsed.y) : `${oreFmt(ctx.parsed.y)} h`
            }`,
        },
      },
    },
    scales: {
      y: {
        type: 'linear' as const,
        position: 'left' as const,
        title: { display: true, text: 'Netto (€)' },
        beginAtZero: true,
      },
      y1: {
        type: 'linear' as const,
        position: 'right' as const,
        title: { display: true, text: 'Ore lavorate (h)' },
        beginAtZero: true,
        grid: { drawOnChartArea: false },
      },
    },
  }

  const composizioneData = {
    labels: composizione.map((d) => d.name),
    datasets: [
      {
        data: composizione.map((d) => d.value),
        backgroundColor: ['#36a2eb', '#ff6384', '#ffce56', '#9966ff', '#4bc0c0'],
        borderWidth: 1,
      },
    ],
  }

  const composizioneOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom' as const },
      tooltip: {
        callbacks: {
          label: (ctx: { label?: string; parsed: number }) => ` ${ctx.label}: ${eur(ctx.parsed)}`,
        },
      },
    },
  }

  const vociData = {
    labels: topVoci.map((v) => v.label),
    datasets: [
      {
        label: vociMode === 'competenze' ? 'Competenze (€)' : 'Ritenute (€)',
        data: topVoci.map((v) => v.value),
        backgroundColor: 'rgba(153, 102, 255, 0.7)',
      },
    ],
  }

  const vociOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { x: number } }) => ` ${eur(ctx.parsed.x)}`,
        },
      },
    },
    scales: {
      x: {
        beginAtZero: true,
        title: { display: true, text: vociMode === 'competenze' ? 'Competenze (€)' : 'Ritenute (€)' },
      },
    },
  }

  const sortedBuste = useMemo(
    () =>
      [...filtered].sort(
        (a, b) =>
          (b.anno ?? 0) - (a.anno ?? 0) || (b.mese_numero ?? 0) - (a.mese_numero ?? 0),
      ),
    [filtered],
  )

  const meseLabel = (m: number | null): string => {
    if (m === 13) return 'Tredicesima'
    if (m === 14) return 'Quattordicesima'
    if (m === null || m < 1 || m > 12) return '—'
    return MESI[m - 1]
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>💶 Dashboard Stipendio</h1>
          <p className="subtitle">
            {loading
              ? 'Caricamento...'
              : `${filtered.length} buste paga · ${filteredDetail.length} voci`}
          </p>
        </div>
        <button className="refresh" onClick={() => load(true)} disabled={loading}>
          ↻ Aggiorna
        </button>
      </header>

      {error && <div className="error">Errore nel caricamento dati: {error}</div>}

      {loading && !data ? (
        <div className="loading">Caricamento buste paga da Unity Catalog…</div>
      ) : (
        <>
          <section className="filters">
            <div className="filter-group">
              <span className="filter-label">Anno</span>
              {anni.map((a) => (
                <Chip key={a} active={selAnni.includes(a)} onClick={() => toggleAnno(a)}>
                  {a}
                </Chip>
              ))}
              {selAnni.length > 0 && (
                <button className="clear" onClick={() => setSelAnni([])}>
                  ✕
                </button>
              )}
            </div>
          </section>

          <section className="kpis">
            <div className="kpi">
              <span className="kpi-label">Netto totale</span>
              <span className="kpi-value">{eur(kpis.netto)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Competenze totali</span>
              <span className="kpi-value">{eur(kpis.competenze)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Ritenute totali</span>
              <span className="kpi-value">{eur(kpis.ritenute)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Buste</span>
              <span className="kpi-value">{kpis.n}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Netto medio</span>
              <span className="kpi-value">
                {kpis.nettoMedio !== null ? eur(kpis.nettoMedio) : '—'}
              </span>
            </div>
          </section>

          <section className="grid">
            <div className="card card-wide">
              <h3>Trend per periodo — netto e ore lavorate</h3>
              <div className="chart-container">
                <Bar data={trendData} options={trendOptions} />
              </div>
            </div>
            <div className="card">
              <h3>Composizione della busta</h3>
              <div className="chart-container">
                {composizione.length > 0 ? (
                  <Doughnut data={composizioneData} options={composizioneOptions} />
                ) : (
                  <p className="empty">Nessun dato</p>
                )}
              </div>
            </div>
            <div className="card">
              <h3>
                Top voci{' '}
                <span className="hint">
                  <Chip
                    active={vociMode === 'competenze'}
                    onClick={() => setVociMode('competenze')}
                  >
                    Competenze
                  </Chip>{' '}
                  <Chip
                    active={vociMode === 'ritenute'}
                    onClick={() => setVociMode('ritenute')}
                  >
                    Ritenute
                  </Chip>
                </span>
              </h3>
              <div className="chart-container">
                {topVoci.length > 0 ? <Bar data={vociData} options={vociOptions} /> : <p className="empty">Nessun dato</p>}
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Buste paga <span className="hint">(clicca una riga per le voci e i dettagli)</span></h3>
            <div className="table-wrapper">
              <table className="bollette-table">
                <thead>
                  <tr>
                    <th>Periodo</th>
                    <th className="right">Ore</th>
                    <th className="right">Competenze</th>
                    <th className="right">Ritenute</th>
                    <th className="right">Netto</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedBuste.map((b) => {
                    const isOpen = expanded === b.file_path
                    return (
                      <Fragment key={b.file_path}>
                        <tr
                          className={`row${isOpen ? ' row-open' : ''}`}
                          onClick={() => setExpanded(isOpen ? null : b.file_path)}
                        >
                          <td>
                            <span className="badge" style={{ background: '#36a2eb' }}>
                              {b.periodo_paga || '—'}
                            </span>
                          </td>
                          <td className="right">
                            {b.ore_lavorate !== null && num(b.ore_lavorate) > 0
                              ? oreFmt(num(b.ore_lavorate))
                              : '—'}
                          </td>
                          <td className="right">{eur(num(b.totale_competenze_eur))}</td>
                          <td className="right">{eur(num(b.totale_ritenute_eur))}</td>
                          <td className="right strong">{eur(num(b.netto_in_busta_eur))}</td>
                        </tr>
                        {isOpen && (
                          <tr className="detail-row">
                            <td colSpan={5}>
                              <div className="detail">
                                <div className="meta-grid">
                                  <div><b>Dipendente:</b> {b.dipendente_nome || '—'}</div>
                                  <div><b>Datore di lavoro:</b> {b.datore_lavoro || '—'}</div>
                                  <div><b>Azienda:</b> {b.azienda || '—'}</div>
                                  <div><b>Mese:</b> {b.anno} · {meseLabel(b.mese_numero)}</div>
                                  <div><b>Giorni lavorati:</b> {b.giorni_lavorati ?? '—'}</div>
                                  <div><b>Giorni retribuiti:</b> {b.giorni_retribuiti ?? '—'}</div>
                                  <div><b>Smart working:</b> {oreFmt(num(b.ore_smart_working))} h</div>
                                  <div><b>Straordinari:</b> {oreFmt(num(b.ore_straordinarie))} h</div>
                                  <div><b>Ferie residue:</b> {oreFmt(num(b.ore_ferie_residue))} h</div>
                                  <div><b>Permessi residui:</b> {oreFmt(num(b.ore_permessi_residui))} h</div>
                                  <div><b>Retribuzione mensile:</b> {eur(num(b.retribuzione_mensile_eur))}</div>
                                  <div><b>TFR mese:</b> {eur(num(b.tfr_mese_eur))}</div>
                                  <div><b>IRPEF netta:</b> {eur(num(b.irpef_netta_mensile_eur))}</div>
                                  <div><b>Addiz. regionale:</b> {eur(num(b.addizionale_regionale_eur))}</div>
                                  <div><b>Addiz. comunale:</b> {eur(num(b.addizionale_comunale_eur))}</div>
                                  <div><b>File:</b> {b.file_name || '—'}</div>
                                </div>
                                <table className="voci-table">
                                  <thead>
                                    <tr>
                                      <th>#</th>
                                      <th>Cod.</th>
                                      <th>Voce</th>
                                      <th className="right">Ore/gg</th>
                                      <th className="right">Dato base</th>
                                      <th className="right">Figurativo</th>
                                      <th className="right">Ritenuta</th>
                                      <th className="right">Competenza</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {vociPerBusta(b.file_path).map((v) => (
                                      <tr key={`${b.file_path}-${v.voce_ordine}`}>
                                        <td>{v.voce_ordine}</td>
                                        <td>{v.codice || '—'}</td>
                                        <td>{v.descrizione || '—'}</td>
                                        <td className="right">
                                          {v.ore_o_giorni !== null ? oreFmt(num(v.ore_o_giorni)) : '—'}
                                        </td>
                                        <td className="right">
                                          {v.dato_base !== null ? oreFmt(num(v.dato_base)) : '—'}
                                        </td>
                                        <td className="right">{eur(num(v.importo_figurativo_eur))}</td>
                                        <td className="right">{eur(num(v.ritenuta_eur))}</td>
                                        <td className="right strong">{eur(num(v.competenza_eur))}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="footer">
            Fonte: Unity Catalog — workspace.cur.entrate_stipendio_header / _dettaglio
            {data?.generated_at ? ` · aggiornato ${new Date(data.generated_at).toLocaleString('it-IT')}` : ''}
          </footer>
        </>
      )}
    </div>
  )
}

function App() {
  const [tipo, setTipo] = useState<Tipo>('luce')
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="shell">
      <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
        <div className="sidebar-header">
          <span className="sidebar-logo">💡</span>
          <span className="sidebar-title">Finanze</span>
          <button
            className="sidebar-toggle"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Espandi pannello' : 'Comprimi pannello'}
          >
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <nav className="sidebar-nav">
          {(Object.keys(CONFIG) as Tipo[]).map((t) => (
            <button
              key={t}
              className={`nav-item${tipo === t ? ' nav-item-active' : ''}`}
              onClick={() => setTipo(t)}
              title={CONFIG[t].titolo}
            >
              <span className="nav-icon">{CONFIG[t].icona}</span>
              <span className="nav-label">{CONFIG[t].navLabel}</span>
            </button>
          ))}
          <button
            className={`nav-item${tipo === 'stipendio' ? ' nav-item-active' : ''}`}
            onClick={() => setTipo('stipendio')}
            title="Dashboard Stipendio"
          >
            <span className="nav-icon">💶</span>
            <span className="nav-label">Stipendio</span>
          </button>
        </nav>
      </aside>
      <main className="content">
        {tipo === 'stipendio' ? (
          <StipendioDashboard key="stipendio" />
        ) : (
          <Dashboard key={tipo} tipo={tipo} />
        )}
      </main>
    </div>
  )
}

export default App 