# --- diagnostics bootstrap: install crash/exception logging before app code ---
import os as _diag_os
import sys as _diag_sys

_diag_dir = _diag_os.path.dirname(_diag_os.path.abspath(__file__))
if _diag_dir not in _diag_sys.path:
    _diag_sys.path.insert(0, _diag_dir)
import app_diagnostics  # noqa: E402

app_diagnostics.install_diagnostics()
# --- end diagnostics bootstrap ---

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import Disposition, Format, StatementState
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Dashboard Finanze: Bollette Luce, Gas e Stipendio")

# --- Databricks / Unity Catalog config ---
CATALOG = os.environ.get("BOLLETTE_CATALOG", "workspace")
CACHE_TTL_SECONDS = 300

# Configurazione per tipo (luce / gas / stipendio): tabelle curate di destinazione
# e colonne di header e dettaglio. Bollette: voci di costo; stipendio: voci busta paga.
_TIPI: dict[str, dict[str, str]] = {
    "luce": {
        "header_table": f"{CATALOG}.cur.bollette_luce_header",
        "detail_table": f"{CATALOG}.cur.bollette_luce_dettaglio",
        "header_columns": """
  file_path, file_name, fornitore, numero_fattura, codice_fornitura,
  codice_pod, cliente_nome, indirizzo_fatturazione,
  data_fattura, periodo_inizio, periodo_fine,
  data_scadenza_pagamento, data_scadenza_offerta,
  importo_totale_da_pagare_eur, potenza_impegnata_kw,
  consumo_fatturato_kwh, consumo_annuo_kwh, nome_offerta,
  metodo_pagamento, mercato, tipologia_cliente
""",
    },
    "gas": {
        "header_table": f"{CATALOG}.cur.bollette_gas_header",
        "detail_table": f"{CATALOG}.cur.bollette_gas_dettaglio",
        "header_columns": """
  file_path, file_name, fornitore, numero_fattura, codice_fornitura,
  codice_pod, categoria_uso, matricola_contatore, cliente_nome,
  indirizzo_fatturazione, data_fattura, periodo_inizio, periodo_fine,
  data_scadenza_pagamento, data_scadenza_offerta,
  importo_totale_da_pagare_eur, consumo_fatturato_effettivo_smc,
  consumo_fatturato_stimato_smc, consumo_annuo_stimato_smc, nome_offerta,
  metodo_pagamento, mercato, tipologia_cliente
""",
    },
    # Buste paga: header una riga per busta, dettaglio una riga per voce.
    "stipendio": {
        "header_table": f"{CATALOG}.cur.entrate_stipendio_header",
        "detail_table": f"{CATALOG}.cur.entrate_stipendio_dettaglio",
        "header_columns": """
  file_path, file_name, datore_lavoro, azienda, dipendente_nome,
  mese_numero, anno, periodo_paga, periodo_data,
  ore_lavorate, ore_smart_working, ore_straordinarie,
  ore_ferie_residue, ore_permessi_residui, giorni_lavorati, giorni_retribuiti,
  retribuzione_mensile_eur, totale_competenze_eur, totale_ritenute_eur,
  netto_in_busta_eur, irpef_netta_mensile_eur,
  addizionale_regionale_eur, addizionale_comunale_eur, tfr_mese_eur
""",
        "header_order": "anno, mese_numero",
        "detail_columns": """
  file_path, anno, mese_numero, voce_ordine, codice, descrizione,
  ore_o_giorni, dato_base, importo_figurativo_eur, ritenuta_eur, competenza_eur
""",
        "detail_order": "anno, mese_numero, voce_ordine",
    },
}


def _header_sql(tipo: str) -> str:
    cfg = _TIPI[tipo]
    return (
        f"SELECT {cfg['header_columns'].strip()}\n"
        f"FROM {cfg['header_table']}\n"
        f"ORDER BY {cfg.get('header_order', 'data_fattura')}"
    )


def _detail_sql(tipo: str) -> str:
    cfg = _TIPI[tipo]
    columns = cfg.get(
        "detail_columns",
        "file_path, fornitore, numero_fattura, data_fattura,\n"
        "voce_ordine, descrizione, importo_eur, quantita",
    )
    return (
        f"SELECT {columns.strip()}\n"
        f"FROM {cfg['detail_table']}\n"
        f"ORDER BY {cfg.get('detail_order', 'data_fattura, numero_fattura, voce_ordine')}"
    )

_sdk_client = None
_warehouse_id = None
_bollette_cache: dict[str, dict[str, Any]] = {}


def _get_client() -> WorkspaceClient:
    # In Databricks Apps the client picks up the app's auth context automatically.
    global _sdk_client
    if _sdk_client is None:
        _sdk_client = WorkspaceClient()
    return _sdk_client


def _get_warehouse_id() -> str:
    global _warehouse_id
    if _warehouse_id is None:
        wid = os.environ.get("BOLLETTE_WAREHOUSE_ID")
        if not wid:
            for wh in _get_client().warehouses.list():
                wid = wh.id
                break
        if not wid:
            raise RuntimeError("Nessun SQL warehouse disponibile nel workspace")
        _warehouse_id = wid
        logger.info("Using SQL warehouse: %s", _warehouse_id)
    return _warehouse_id


def _run_query(sql: str) -> list[dict[str, Any]]:
    client = _get_client()
    stmt = client.statement_execution.execute_statement(
        statement=sql,
        warehouse_id=_get_warehouse_id(),
        disposition=Disposition.INLINE,
        format=Format.JSON_ARRAY,
    )
    # Poll until the statement is no longer running (INLINE is usually immediate).
    while stmt.status.state in (StatementState.PENDING, StatementState.RUNNING):
        time.sleep(1)
        stmt = client.statement_execution.get_statement(stmt.statement_id)
    if stmt.status.state == StatementState.FAILED:
        message = getattr(stmt.status.error, "message", "unknown error")
        raise RuntimeError(f"Query fallita: {message}")
    columns = [c.name for c in stmt.manifest.schema.columns]
    rows: list[dict[str, Any]] = []
    for raw in stmt.result.data_array or []:
        # A seconda della versione del SDK, gli elementi di data_array arrivano
        # come stringhe JSON da deserializzare o come liste già deserializzate.
        values = json.loads(raw) if isinstance(raw, str) else raw
        rows.append(dict(zip(columns, values)))
    return rows


# --- API Routes ---
@app.get("/api/hello")
async def hello():
    logger.info("Accessed /api/hello")
    return {"message": "Hello from FastAPI!"}


@app.get("/api/health")
async def health_check():
    logger.info("Health check at /api/health")
    return {"status": "healthy"}


@app.get("/api/bollette")
async def get_bollette(tipo: str = "luce", refresh: bool = False):
    """Restituisce bollette (header) e voci di costo (dettaglio) da Unity Catalog.

    `?tipo=luce` (default) legge le tabelle curate luce, `?tipo=gas` quelle gas,
    `?tipo=stipendio` le buste paga (entrate stipendio Relatech).
    I dati sono piccoli (decine di righe), quindi un solo endpoint che restituisce
    tutto e lascia al frontend l'interattività (filtri, grafici). Cache di 5 minuti
    per tipo; `?refresh=true` la bypassa.
    """
    if tipo not in _TIPI:
        raise HTTPException(
            status_code=400,
            detail=f"tipo non valido: {tipo!r} (valori ammessi: {', '.join(_TIPI)})",
        )
    cache = _bollette_cache.setdefault(tipo, {"ts": 0.0, "data": None})
    now = time.time()
    if (
        not refresh
        and cache["data"] is not None
        and now - cache["ts"] < CACHE_TTL_SECONDS
    ):
        return cache["data"]
    try:
        header = _run_query(_header_sql(tipo))
        dettaglio = _run_query(_detail_sql(tipo))
    except Exception as exc:
        logger.exception("Errore lettura tabelle bollette (tipo=%s)", tipo)
        raise HTTPException(status_code=500, detail=str(exc))
    payload = {
        "tipo": tipo,
        "header": header,
        "dettaglio": dettaglio,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    cache.update(ts=now, data=payload)
    logger.info(
        "Loaded %d bollette and %d voci di costo (tipo=%s)",
        len(header), len(dettaglio), tipo,
    )
    return payload

# --- Static Files Setup ---
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(static_dir, exist_ok=True)

app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

# --- Catch-all for React Routes ---
@app.get("/{full_path:path}")
async def serve_react(full_path: str):
    index_html = os.path.join(static_dir, "index.html")
    if os.path.exists(index_html):
        logger.info(f"Serving React frontend for path: /{full_path}")
        return FileResponse(index_html)
    logger.error("Frontend not built. index.html missing.")
    raise HTTPException(
        status_code=404,
        detail="Frontend not built. Please run 'npm run build' first."
    )