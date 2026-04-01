# IBKR Veroilmoitus

Calculate Finnish capital gains tax (luovutusvoitot ja -tappiot) from Interactive Brokers Activity Statement CSV exports.

**Runs entirely in your browser** — your trade data never leaves your machine.

## Usage

1. Open `index.html` in your browser (or visit the [GitHub Pages site](https://choppy.github.io/ibkr-veroilmoitus/))
2. Drag and drop your IBKR Activity Statement CSV
3. Copy the tax figures into OmaVero

## How to export from IBKR

1. Log in to IBKR → **Performance & Reports** → **Statements**
2. Select **Activity** statement, period covering the tax year, format **CSV**
3. Download the file

## What it calculates

- **Luovutushinnat yhteensä** — total disposal prices (EUR)
- **Luovutusvoitot yhteensä** — total capital gains (EUR)  
- **Luovutustappiot yhteensä** — total capital losses (EUR)

Exchange rates are fetched from the ECB (European Central Bank) daily EUR/USD rates for accurate per-trade conversion.

## How it works

- Parses the `Trades` section of the IBKR Activity Statement CSV
- Only processes actual trade executions (discriminator = "Trade"), skipping Order and ClosedLot aggregations
- For each closing trade (Code contains "C"):
  - Converts USD proceeds to EUR using the ECB rate for that trade date
  - Uses IBKR's Realized P/L which already includes commissions
  - Accumulates gains and losses separately
- Handles edge cases: quoted CSV fields with commas, thousands separators in quantities, weekend/holiday rate fallback

## OmaVero

In OmaVero, go to:
- **Muut tulot** → **Arvopaperien myyntivoitot** → **Kyllä** → **Avaa erittely**
- Choose option B (liitetiedosto) and attach your IBKR Activity Statement
- Enter the three figures from this tool

## License

MIT
