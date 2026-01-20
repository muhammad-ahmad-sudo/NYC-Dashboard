# NYC Yellow Taxi 2023 — Interactive Trip Explorer (D3 Dashboard)

It supports common exploratory analysis tasks:

- **Temporal demand:** *When* are trips most frequent (by date, day-of-week, hour)?
- **Fare vs. distance:** How does **total_amount** scale with **trip_distance**? Where are outliers?
- **Payment behavior:** How do distributions of **total_amount** differ by **payment_type**?
- **Spatial flows (proxy):** Which **pickup → dropoff** zone corridors dominate (Sankey)?

## What’s included

- `preprocess.py` — turns the raw trip CSV into lightweight files for the web dashboard:
  - `web/data/daily.csv`
  - `web/data/daily_hour.csv`
  - `web/data/sample.csv`
  - `web/data/meta.json`
- `web/index.html`, `web/main.js`, `web/style.css` — the interactive visualization (D3 v7 + SVG).
- Pre-generated `web/data/*` based on the attached dataset (so you can run immediately).

## Visualization techniques (meets assignment requirement)

Distinct techniques used in the dashboard:

1. **Line/area chart** — daily trip volume (time series)
2. **Heatmap** — hour × day-of-week volume
3. **Scatterplot** — trip_distance vs total_amount (sampled points)
4. **Histogram** — distribution of trip_distance
5. **Box plot** — distribution of total_amount by payment_type


## Interactions (>= 2)

- **Brushing** on the time series → filters date range (linked to other views)
- **Brushing** on the scatterplot (2D) → filters distance × total range
- **Brushing** on the histogram → filters distance (bidirectional with scatterplot)
- **Click selection** on heatmap → filters hour + weekday
- **Click selection** on box plot + dropdown → filters payment type
- **Click selection** on Sankey nodes → filters pickup or dropoff zone
- **Tooltips** on hover for multiple marks (points, bars, heatmap cells, Sankey links/nodes)

## Notes on performance

- The raw CSV can be big. The dashboard uses:
  - **aggregates** for time series and heatmap
  - a **random sample** for point-heavy views (scatter/box/sankey)
- You can increase/decrease `--sample` based on your machine and browser.

## Data dictionary highlights

- `payment_type` mapping (TLC standard):
  - 1=Credit card, 2=Cash, 3=No charge, 4=Dispute, 5=Unknown, 6=Voided trip
- `PULocationID`, `DOLocationID` are TLC taxi zone IDs (numeric). If you want zone names, add a taxi-zone lookup table and join it in preprocessing.
