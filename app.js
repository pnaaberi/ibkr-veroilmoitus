const views = {
  upload: document.getElementById("upload-view"),
  processing: document.getElementById("processing-view"),
  results: document.getElementById("results-view"),
  error: document.getElementById("error-view"),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

// ── Number formatting ────────────────────────────────────────────────────

function fmtFi(n) {
  const abs = Math.abs(n).toFixed(2);
  const [int, dec] = abs.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return grouped + "," + dec;
}

function fmtOmavero(n) {
  return Math.abs(n).toFixed(2).replace(".", ",");
}

function fmtUsd(n) {
  const sign = n >= 0 ? "+" : "\u2212";
  const abs = Math.abs(n).toFixed(2);
  const [int, dec] = abs.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return sign + "$" + grouped + "." + dec;
}

// ── CSV parsing ──────────────────────────────────────────────────────────

function parseNum(s) {
  s = s.trim().replace(/,/g, "");
  return s ? parseFloat(s) : 0;
}

function parseLine(line) {
  const parts = [];
  let inQuote = false;
  let cur = "";
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function parseTrades(content) {
  // Strip BOM and normalize line endings
  content = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trades = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("Trades,")) continue;
    const p = parseLine(line.trimEnd());
    if (p.length < 17 || p[1] !== "Data" || p[2] !== "Trade") continue;

    let qty;
    try {
      qty = parseNum(p[8]);
      if (isNaN(qty)) continue;
    } catch {
      continue;
    }

    const dateTime = p[6];
    const tradeDate = dateTime.includes(",")
      ? dateTime.split(",")[0].trim()
      : dateTime.slice(0, 10);

    trades.push({
      asset: p[3],
      currency: p[4],
      symbol: p[5],
      date: tradeDate,
      qty,
      proceeds: parseNum(p[11]),
      commission: parseNum(p[12]),
      basis: parseNum(p[13]),
      realized_pl: parseNum(p[14]),
      code: p[16] || "",
    });
  }
  return trades;
}

// ── ECB rates ────────────────────────────────────────────────────────────

const ratesCache = {};

async function fetchEcbRates(year) {
  if (ratesCache[year]) return ratesCache[year];
  const url =
    `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A` +
    `?startPeriod=${year}-01-01&endPeriod=${year}-12-31&format=csvdata`;

  const rates = {};
  try {
    const resp = await fetch(url);
    const text = await resp.text();
    const lines = text.split("\n");
    if (lines.length < 2) return rates;
    const headers = parseCsvRow(lines[0]);
    const dateIdx = headers.indexOf("TIME_PERIOD");
    const valIdx = headers.indexOf("OBS_VALUE");
    if (dateIdx < 0 || valIdx < 0) return rates;

    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvRow(lines[i]);
      if (row[dateIdx] && row[valIdx]) {
        rates[row[dateIdx]] = 1.0 / parseFloat(row[valIdx]);
      }
    }
  } catch {
    // fallback handled in getFxRate
  }
  ratesCache[year] = rates;
  return rates;
}

function parseCsvRow(line) {
  // simple CSV row parser for ECB data (no quoted commas)
  return line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

async function getRatesForTrades(trades) {
  const years = new Set();
  for (const t of trades) {
    if (t.date.length >= 4) years.add(t.date.slice(0, 4));
  }
  const allRates = {};
  for (const y of years) {
    Object.assign(allRates, await fetchEcbRates(parseInt(y)));
  }
  return allRates;
}

function getFxRate(dateStr, rates) {
  if (rates[dateStr]) return rates[dateStr];
  const dt = new Date(dateStr);
  for (let delta = 1; delta <= 7; delta++) {
    for (const dir of [-1, 1]) {
      const d = new Date(dt);
      d.setDate(d.getDate() + dir * delta);
      const ds = d.toISOString().slice(0, 10);
      if (rates[ds]) return rates[ds];
    }
  }
  return 0.92;
}

// ── Tax calculation ──────────────────────────────────────────────────────

function computeTax(trades, fxRates) {
  const result = {
    luovutushinnat: 0,
    luovutusvoitot: 0,
    luovutustappiot: 0,
    total_realized_usd: 0,
    total_commission_usd: 0,
    trade_count: trades.length,
    open_count: 0,
    close_count: 0,
    by_asset: {},
    by_month: {},
    by_symbol: {},
  };

  for (const t of trades) {
    const isClose = t.code.includes("C");
    const fx = t.currency === "USD" ? getFxRate(t.date, fxRates) : 1.0;

    result.total_realized_usd += t.realized_pl;
    result.total_commission_usd += t.commission;

    const asset = t.asset;
    const month = t.date.slice(0, 7);
    const symbol = t.symbol;

    result.by_asset[asset] = (result.by_asset[asset] || 0) + t.realized_pl;
    result.by_month[month] = (result.by_month[month] || 0) + t.realized_pl;
    result.by_symbol[symbol] = (result.by_symbol[symbol] || 0) + t.realized_pl;

    if (isClose) {
      result.close_count++;
      const disposal =
        t.qty < 0
          ? Math.abs(t.proceeds) * fx
          : Math.abs(t.basis) * fx;
      result.luovutushinnat += disposal;

      const netEur = t.realized_pl * fx;
      if (netEur > 0) result.luovutusvoitot += netEur;
      else if (netEur < 0) result.luovutustappiot += netEur;
    } else {
      result.open_count++;
    }
  }

  // Round
  result.luovutushinnat = Math.round(result.luovutushinnat * 100) / 100;
  result.luovutusvoitot = Math.round(result.luovutusvoitot * 100) / 100;
  result.luovutustappiot = Math.round(result.luovutustappiot * 100) / 100;
  result.total_realized_usd = Math.round(result.total_realized_usd * 100) / 100;
  result.total_commission_usd =
    Math.round(result.total_commission_usd * 100) / 100;

  // Sort by_symbol by value (worst first)
  const sorted = Object.entries(result.by_symbol).sort((a, b) => a[1] - b[1]);
  result.by_symbol = Object.fromEntries(sorted);

  // Sort by_month, by_asset
  result.by_month = Object.fromEntries(
    Object.entries(result.by_month).sort((a, b) => a[0].localeCompare(b[0]))
  );
  result.by_asset = Object.fromEntries(
    Object.entries(result.by_asset).sort((a, b) => a[0].localeCompare(b[0]))
  );

  return result;
}

// ── File handling ────────────────────────────────────────────────────────

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  showView("processing");
  const statusEl = document.getElementById("status-text");

  try {
    statusEl.textContent = "Luetaan tiedostoa...";
    const content = await file.text();

    statusEl.textContent = "Jäsennetään kauppoja...";
    const trades = parseTrades(content);
    if (!trades.length) {
      document.getElementById("error-text").textContent =
        "Tiedostosta ei löytynyt kauppoja. Varmista että kyseessä on IBKR Activity Statement CSV.";
      showView("error");
      return;
    }

    statusEl.textContent = `Haetaan ECB-valuuttakurssit (${trades.length} kauppaa)...`;
    const fxRates = await getRatesForTrades(trades);

    statusEl.textContent = "Lasketaan verotietoja...";
    const result = computeTax(trades, fxRates);

    renderResults(result);
    showView("results");
  } catch (err) {
    document.getElementById("error-text").textContent = "Virhe: " + err.message;
    showView("error");
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderResults(d) {
  const months = Object.keys(d.by_month);
  const year = months.length ? months[0].slice(0, 4) : "";
  document.getElementById("result-year").textContent = year;

  document.getElementById("val-luovutushinnat").textContent =
    fmtFi(d.luovutushinnat) + " \u20ac";
  document.getElementById("val-luovutusvoitot").textContent =
    fmtFi(d.luovutusvoitot) + " \u20ac";
  document.getElementById("val-luovutustappiot").textContent =
    fmtFi(Math.abs(d.luovutustappiot)) + " \u20ac";

  document.getElementById("val-trades").textContent = d.trade_count;
  document.getElementById("val-opens").textContent = d.open_count;
  document.getElementById("val-closes").textContent = d.close_count;
  document.getElementById("val-rpl-usd").textContent = fmtUsd(
    d.total_realized_usd
  );
  document.getElementById("val-comm-usd").textContent = fmtUsd(
    d.total_commission_usd
  );

  // Copy buttons
  const copyMap = {
    luovutushinnat: d.luovutushinnat,
    luovutusvoitot: d.luovutusvoitot,
    luovutustappiot: Math.abs(d.luovutustappiot),
  };

  document.querySelectorAll(".copy-btn").forEach((btn) => {
    const field = btn.closest(".card").dataset.field;
    btn.onclick = () => {
      navigator.clipboard.writeText(fmtOmavero(copyMap[field]));
      btn.classList.add("copied");
      btn.textContent = "\u2713";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = "\uf0c5";
      }, 1500);
    };
  });

  renderCharts(d, months);
  renderTable("table-symbol", d.by_symbol);
  renderTable("table-asset", d.by_asset);
  renderTable("table-month", d.by_month);
}

let monthlyChart = null;
let cumulativeChart = null;

function renderCharts(d, months) {
  const labels = months.map((m) => m.slice(5));
  const values = months.map((m) => d.by_month[m] || 0);
  const cumulative = [];
  values.reduce((sum, v, i) => {
    cumulative[i] = sum + v;
    return cumulative[i];
  }, 0);

  const barColors = values.map((v) =>
    v >= 0 ? "rgba(74, 158, 126, 0.8)" : "rgba(196, 80, 80, 0.8)"
  );

  const chartOpts = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: "#6a8a84", font: { family: "monospace", size: 11 } },
        grid: { color: "rgba(42, 62, 56, 0.5)" },
      },
      y: {
        ticks: { color: "#6a8a84", font: { family: "monospace", size: 11 } },
        grid: { color: "rgba(42, 62, 56, 0.5)" },
      },
    },
  };

  if (monthlyChart) monthlyChart.destroy();
  if (cumulativeChart) cumulativeChart.destroy();

  monthlyChart = new Chart(document.getElementById("chart-monthly"), {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: barColors, borderRadius: 3 }],
    },
    options: chartOpts,
  });

  cumulativeChart = new Chart(document.getElementById("chart-cumulative"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data: cumulative,
          borderColor: "#4a9e7e",
          backgroundColor: "rgba(74, 158, 126, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: "#4a9e7e",
        },
      ],
    },
    options: chartOpts,
  });
}

function renderTable(tableId, data) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = "";
  for (const [key, val] of Object.entries(data)) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = key;
    const td2 = document.createElement("td");
    td2.className = val >= 0 ? "val-pos" : "val-neg";
    td2.textContent = fmtUsd(Math.round(val * 100) / 100);
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ── Reset ────────────────────────────────────────────────────────────────

document.getElementById("reset-btn").addEventListener("click", () => {
  fileInput.value = "";
  showView("upload");
});
document.getElementById("error-reset-btn").addEventListener("click", () => {
  fileInput.value = "";
  showView("upload");
});
