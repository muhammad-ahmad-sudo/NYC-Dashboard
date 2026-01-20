
(function () {
  const fmtInt = d3.format(",d");
  const fmt1 = d3.format(".1f");
  const fmt2 = d3.format(".2f");
  const fmtPct = d3.format(".0%");

  const parseDay = d3.timeParse("%Y-%m-%d");
  const parseISO = d3.timeParse("%Y-%m-%dT%H:%M:%S");

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const paymentLabel = (pt) => {
    const m = {
      1: "Credit card",
      2: "Cash",
      3: "No charge",
      4: "Dispute",
      5: "Unknown",
      6: "Voided trip",
    };
    return m[pt] ?? `Payment ${pt}`;
  };

  // ---------- Tooltip ----------
  const tooltip = d3.select("#tooltip");
  function showTooltip(html, x, y) {
    tooltip
      .style("opacity", 1)
      .style("left", `${Math.min(window.innerWidth - 340, x + 12)}px`)
      .style("top", `${Math.min(window.innerHeight - 140, y + 12)}px`)
      .html(html)
      .attr("aria-hidden", "false");
  }
  function hideTooltip() {
    tooltip.style("opacity", 0).attr("aria-hidden", "true");
  }

  // ---------- Global State ----------
  const state = {
    // dateRange in ms at day granularity: [startDayMs, endDayMs] inclusive
    dateRange: null,
    // distance & fare ranges are numeric (miles, USD)
    distanceRange: null,
    fareRange: null,
    // filters
    paymentType: "all", // 'all' or number as string
    dow: null, // 0-6 (Mon..Sun)
    hour: null, // 0-23
    pu: null,   // pickup zone id
    do: null,   // dropoff zone id
  };

  // ---------- Data ----------
  const DATA = {
    daily: [],
    dailyHour: [],
    sample: [],
    meta: null,
  };

  // Helpers
  const dayMs = (dateObj) => +d3.timeDay(dateObj);

  function inRange(value, range) {
    if (!range) return true;
    return value >= range[0] && value <= range[1];
  }

  function filtersToBadges() {
    const badges = [];

    if (state.dateRange) {
      const a = new Date(state.dateRange[0]);
      const b = new Date(state.dateRange[1]);
      badges.push(`📅 ${d3.timeFormat("%b %d")(a)} → ${d3.timeFormat("%b %d")(b)}`);
    } else {
      badges.push("📅 all dates");
    }

    if (state.paymentType !== "all") {
      badges.push(`💳 ${paymentLabel(+state.paymentType)}`);
    } else {
      badges.push("💳 all payments");
    }

    if (state.dow != null && state.hour != null) {
      badges.push(`🕒 ${DOW[state.dow]} @ ${state.hour}:00`);
    }

    if (state.distanceRange) {
      badges.push(`📏 ${fmt1(state.distanceRange[0])}–${fmt1(state.distanceRange[1])} mi`);
    }

    if (state.fareRange) {
      badges.push(`💵 $${fmt2(state.fareRange[0])}–$${fmt2(state.fareRange[1])}`);
    }

    if (state.pu != null) {
      badges.push(`⬆️ PU ${state.pu}`);
    }
    if (state.do != null) {
      badges.push(`⬇️ DO ${state.do}`);
    }

    return badges.map((t) => `<span class="badge">${t}</span>`).join("");
  }

  function updateReadout(filteredTrips) {
    const el = d3.select("#filterReadout");

    const trips = filteredTrips.length;
    const avgDist = trips ? d3.mean(filteredTrips, (d) => d.trip_distance) : 0;
    const avgTotal = trips ? d3.mean(filteredTrips, (d) => d.total_amount) : 0;
    const tipRate = trips ? d3.mean(filteredTrips, (d) => (d.tip_amount > 0 ? 1 : 0)) : 0;

    el.html(`
      <div style="margin-bottom:6px">${filtersToBadges()}</div>
      <div class="kpi"><strong>${fmtInt(trips)}</strong> trips in sample</div>
      <div class="kpi"><strong>${fmt1(avgDist)}</strong> mi avg</div>
      <div class="kpi"><strong>$${fmt2(avgTotal)}</strong> total avg</div>
      <div class="kpi"><strong>${fmtPct(tipRate)}</strong> tipped</div>
    `);
  }

  function filterSampleTrips(ignorePayment = false) {
    // Filters the *sample* trips (used for point-based views)
    const start = state.dateRange ? state.dateRange[0] : -Infinity;
    const end = state.dateRange ? state.dateRange[1] : Infinity;

    return DATA.sample.filter((d) => {
      if (!(d.day_ms >= start && d.day_ms <= end)) return false;

      if (!ignorePayment && state.paymentType !== "all" && d.payment_type !== +state.paymentType) return false;

      if (state.dow != null && d.dow !== state.dow) return false;
      if (state.hour != null && d.hour !== state.hour) return false;

      if (state.pu != null && d.PULocationID !== state.pu) return false;
      if (state.do != null && d.DOLocationID !== state.do) return false;

      if (!inRange(d.trip_distance, state.distanceRange)) return false;
      if (!inRange(d.total_amount, state.fareRange)) return false;

      return true;
    });
  }

  // ---------- Charts ----------
  // Each chart exposes: resize(), update()

  // Time series (daily line + brush)
  function TimeSeriesChart(svgSel) {
    const margin = { top: 18, right: 20, bottom: 28, left: 52 };
    const height = 220;
    let width = 800;

    const svg = svgSel;
    const g = svg.append("g");
    const gGrid = g.append("g").attr("class", "grid");
    const gAxisX = g.append("g").attr("class", "axis axis-x");
    const gAxisY = g.append("g").attr("class", "axis axis-y");
    const pathArea = g.append("path").attr("fill", "rgba(26,115,232,0.15)");
    const pathLine = g.append("path").attr("fill", "none").attr("stroke", "rgba(26,115,232,0.95)").attr("stroke-width", 2);

    const focusG = g.append("g").style("display", "none");
    const focusLine = focusG.append("line").attr("y1", 0).attr("y2", 1).attr("stroke", "rgba(60,64,67,0.65)").attr("stroke-dasharray", "3,3");
    const focusDot = focusG.append("circle").attr("r", 4).attr("fill", "rgba(60,64,67,0.85)");

    const brushG = g.append("g").attr("class", "brush");
    const brush = d3.brushX();

    // overlay for hover tooltip
    const overlay = g.append("rect").attr("fill", "transparent").style("cursor", "crosshair");

    const x = d3.scaleTime();
    const y = d3.scaleLinear();

    const area = d3.area()
      .x((d) => x(d.date))
      .y0(() => y(0))
      .y1((d) => y(d.trips))
      .curve(d3.curveMonotoneX);

    const line = d3.line()
      .x((d) => x(d.date))
      .y((d) => y(d.trips))
      .curve(d3.curveMonotoneX);

    let suppressBrush = false;

    function resize() {
      width = Math.max(420, svg.node().clientWidth || 800);
      svg.attr("viewBox", [0, 0, width, height]);

      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      g.attr("transform", `translate(${margin.left},${margin.top})`);

      x.range([0, innerW]);
      y.range([innerH, 0]);

      // Update brush extent + overlay
      brush.extent([[0, 0], [innerW, innerH]]);
      brushG.call(brush);
      overlay.attr("width", innerW).attr("height", innerH);

      focusLine.attr("y2", innerH);

      update(); // redraw with new dimensions
    }

    function update() {
      const data = DATA.daily;
      if (!data || !data.length) return;

      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      x.domain(d3.extent(data, (d) => d.date));
      y.domain([0, d3.max(data, (d) => d.trips) * 1.06]).nice();

      // grid
      const yTicks = y.ticks(5);
      gGrid.selectAll("line")
        .data(yTicks)
        .join("line")
        .attr("x1", 0)
        .attr("x2", innerW)
        .attr("y1", (t) => y(t))
        .attr("y2", (t) => y(t))
        .attr("stroke", "#000000");

      // axes
      gAxisX.attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(Math.min(10, data.length)).tickFormat(d3.timeFormat("%b %d")));
      gAxisY.call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));

      // paths
      pathArea.datum(data).attr("d", area);
      pathLine.datum(data).attr("d", line);

      // Brush -> update state
      brushG.on("dblclick", (event) => {
        event.preventDefault();
        setState({ dateRange: null });
      });

      brush.on("end", (event) => {
        if (suppressBrush) return;
        if (!event.selection) {
          setState({ dateRange: null });
          return;
        }
        const [px0, px1] = event.selection;
        const d0 = x.invert(px0);
        const d1 = x.invert(px1);

        const start = dayMs(d0);
        const end = dayMs(d1);
        // inclusive end
        setState({ dateRange: [Math.min(start, end), Math.max(start, end)] });
      });

      brushG.call(brush);

      // Programmatic brush move to reflect state
      suppressBrush = true;
      if (state.dateRange) {
        const [a, b] = state.dateRange;
        brushG.call(brush.move, [x(new Date(a)), x(new Date(b))]);
      } else {
        brushG.call(brush.move, null);
      }
      suppressBrush = false;

      // Hover tooltip
      const bisect = d3.bisector((d) => d.date).left;

      overlay
        .on("mouseenter", () => focusG.style("display", null))
        .on("mouseleave", () => {
          focusG.style("display", "none");
          hideTooltip();
        })
        .on("mousemove", (event) => {
          const [mx] = d3.pointer(event, overlay.node());
          const date = x.invert(mx);
          const i = bisect(data, date, 1);
          const a = data[i - 1];
          const b = data[i] ?? a;
          const d = (date - a.date) > (b.date - date) ? b : a;

          const cx = x(d.date);
          const cy = y(d.trips);
          focusLine.attr("x1", cx).attr("x2", cx);
          focusDot.attr("cx", cx).attr("cy", cy);

          showTooltip(
            `<div class="tt-title">${d3.timeFormat("%A, %b %d, %Y")(d.date)}</div>
             <div><strong>${fmtInt(d.trips)}</strong> trips</div>
             <div>Avg distance: <strong>${fmt1(d.avg_distance)}</strong> mi</div>
             <div>Avg total: <strong>$${fmt2(d.avg_total)}</strong></div>
             <div>Tip rate: <strong>${fmtPct(d.pct_tipped)}</strong></div>`,
            event.clientX,
            event.clientY
          );
        });
    }

    return { resize, update };
  }

  // Heatmap: hour x day-of-week (aggregated by date brush)
  function HeatmapChart(svgSel) {
    const margin = { top: 22, right: 16, bottom: 34, left: 46 };
    const height = 260;
    let width = 800;

    const svg = svgSel;
    const g = svg.append("g");

    const gCells = g.append("g");
    const gAxisX = g.append("g").attr("class", "axis axis-x");
    const gAxisY = g.append("g").attr("class", "axis axis-y");

    const x = d3.scaleBand().domain(d3.range(24)).paddingInner(0.06).paddingOuter(0.02);
    const y = d3.scaleBand().domain(d3.range(7)).paddingInner(0.10).paddingOuter(0.02);
    const color = d3.scaleSequential(d3.interpolateBlues);

    function resize() {
      width = Math.max(420, svg.node().clientWidth || 800);
      svg.attr("viewBox", [0, 0, width, height]);

      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      g.attr("transform", `translate(${margin.left},${margin.top})`);

      x.range([0, innerW]);
      y.range([0, innerH]);

      update();
    }

    function matrixForDateRange() {
      const mat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ trips: 0, avg_total_sum: 0, avg_distance_sum: 0, n: 0 })));

      const start = state.dateRange ? state.dateRange[0] : -Infinity;
      const end = state.dateRange ? state.dateRange[1] : Infinity;

      for (const r of DATA.dailyHour) {
        if (!(r.day_ms >= start && r.day_ms <= end)) continue;

        const cell = mat[r.dow][r.hour];
        cell.trips += r.trips;
        // Weighted sums for averages (approx)
        cell.avg_total_sum += r.avg_total * r.trips;
        cell.avg_distance_sum += r.avg_distance * r.trips;
        cell.n += r.trips;
      }

      // flatten
      const cells = [];
      for (let dow = 0; dow < 7; dow++) {
        for (let hour = 0; hour < 24; hour++) {
          const c = mat[dow][hour];
          const avg_total = c.n ? c.avg_total_sum / c.n : 0;
          const avg_distance = c.n ? c.avg_distance_sum / c.n : 0;
          cells.push({ dow, hour, trips: c.trips, avg_total, avg_distance });
        }
      }
      return cells;
    }

    function update() {
      const cells = matrixForDateRange();
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const maxTrips = d3.max(cells, (d) => d.trips) || 1;
      color.domain([0, maxTrips]);

      // axes
      gAxisX.attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).tickValues([0, 4, 8, 12, 16, 20, 23]).tickFormat((d) => `${d}`));
      gAxisY.call(d3.axisLeft(y).tickFormat((d) => DOW[d]));

      // cells
      const sel = gCells.selectAll("rect.cell")
        .data(cells, (d) => `${d.dow}-${d.hour}`);

      sel.join(
        (enter) => enter.append("rect")
          .attr("class", "cell")
          .attr("x", (d) => x(d.hour))
          .attr("y", (d) => y(d.dow))
          .attr("width", x.bandwidth())
          .attr("height", y.bandwidth())
          .attr("rx", 4)
          .attr("fill", (d) => color(d.trips))
          .attr("stroke", "#000000")
          .attr("stroke-width", 0.8)
          .style("cursor", "pointer")
          .on("mouseenter", (event, d) => {
            showTooltip(
              `<div class="tt-title">${DOW[d.dow]} @ ${d.hour}:00</div>
               <div><strong>${fmtInt(d.trips)}</strong> trips</div>
               <div>Avg distance: <strong>${fmt1(d.avg_distance)}</strong> mi</div>
               <div>Avg total: <strong>$${fmt2(d.avg_total)}</strong></div>
               <div style="margin-top:6px;color:rgba(95,99,104,0.75)">Click to filter hour+weekday</div>`,
              event.clientX,
              event.clientY
            );
          })
          .on("mousemove", (event) => showTooltip(tooltip.html(), event.clientX, event.clientY))
          .on("mouseleave", hideTooltip)
          .on("click", (event, d) => {
            const same = (state.dow === d.dow) && (state.hour === d.hour);
            setState({ dow: same ? null : d.dow, hour: same ? null : d.hour });
          }),
        (update) => update
          .transition()
          .duration(250)
          .attr("fill", (d) => color(d.trips))
      );

      // Selected cell outline (drawn as a separate overlay)
      const outline = gCells.selectAll("rect.selection-outline")
        .data(state.dow != null && state.hour != null ? [1] : []);

      outline.join(
        (enter) => enter.append("rect")
          .attr("class", "selection-outline")
          .attr("rx", 6)
          .attr("fill", "none")
          .attr("stroke", "rgba(0,0,0,0.95)")
          .attr("stroke-width", 2)
          .attr("pointer-events", "none")
          .attr("x", () => x(state.hour))
          .attr("y", () => y(state.dow))
          .attr("width", x.bandwidth())
          .attr("height", y.bandwidth()),
        (update) => update
          .attr("x", () => x(state.hour))
          .attr("y", () => y(state.dow))
          .attr("width", x.bandwidth())
          .attr("height", y.bandwidth()),
        (exit) => exit.remove()
      );
    }

    return { resize, update };
  }

  // Scatterplot: distance vs total, with 2D brush
  function ScatterChart(svgSel) {
    const margin = { top: 16, right: 20, bottom: 42, left: 56 };
    const height = 340;
    let width = 800;

    const svg = svgSel;
    const g = svg.append("g");
    const gAxisX = g.append("g").attr("class", "axis axis-x");
    const gAxisY = g.append("g").attr("class", "axis axis-y");
    const gPoints = g.append("g");
    const brushG = g.append("g").attr("class", "brush");

    const x = d3.scaleLinear();
    const y = d3.scaleLinear();

    // color by payment type (categorical)
    const payTypes = [1, 2, 3, 4, 5, 6];
    const color = d3.scaleOrdinal()
      .domain(payTypes)
      .range(d3.schemeTableau10.slice(0, 6));

    const brush = d3.brush();
    let suppressBrush = false;

    function resize() {
      width = Math.max(420, svg.node().clientWidth || 800);
      svg.attr("viewBox", [0, 0, width, height]);

      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      g.attr("transform", `translate(${margin.left},${margin.top})`);

      x.range([0, innerW]);
      y.range([innerH, 0]);

      brush.extent([[0, 0], [innerW, innerH]]);
      brushG.call(brush);

      update();
    }

    function update() {
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      // Use robust domains (based on 99th percentile) for stable axes
      const distances = DATA.sample.map((d) => d.trip_distance).sort(d3.ascending);
      const totals = DATA.sample.map((d) => d.total_amount).sort(d3.ascending);
      const dxMax = d3.quantileSorted(distances, 0.99) || d3.max(distances) || 10;
      const tyMax = d3.quantileSorted(totals, 0.99) || d3.max(totals) || 50;

      x.domain([0, Math.ceil(dxMax * 1.02)]).nice();
      y.domain([0, Math.ceil(tyMax * 1.02)]).nice();

      // axes
      gAxisX.attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(6));
      gAxisY.call(d3.axisLeft(y).ticks(6));

      // axis labels
      const xLab = g.selectAll("text.xlab").data([1]);
      xLab.join(
        (enter) => enter.append("text")
          .attr("class", "xlab")
          .attr("x", innerW)
          .attr("y", innerH + 34)
          .attr("text-anchor", "end")
          .attr("fill", "rgba(60,64,67,0.80)")
          .attr("font-size", 12)
          .text("Trip distance (miles)")
      );

      const yLab = g.selectAll("text.ylab").data([1]);
      yLab.join(
        (enter) => enter.append("text")
          .attr("class", "ylab")
          .attr("x", 0)
          .attr("y", -6)
          .attr("text-anchor", "start")
          .attr("fill", "rgba(60,64,67,0.80)")
          .attr("font-size", 12)
          .text("Total amount ($)")
      );

      // Base filtered set ignoring range filters, so brushing shows context
      const start = state.dateRange ? state.dateRange[0] : -Infinity;
      const end = state.dateRange ? state.dateRange[1] : Infinity;

      const baseTrips = DATA.sample.filter((d) => {
        if (!(d.day_ms >= start && d.day_ms <= end)) return false;
        if (state.paymentType !== "all" && d.payment_type !== +state.paymentType) return false;
        if (state.dow != null && d.dow !== state.dow) return false;
        if (state.hour != null && d.hour !== state.hour) return false;
        if (state.pu != null && d.PULocationID !== state.pu) return false;
        if (state.do != null && d.DOLocationID !== state.do) return false;
        return true;
      });

      // Downsample a bit for SVG performance if needed
      const maxPoints = 18000;
      const trips = baseTrips.length <= maxPoints ? baseTrips : d3.shuffle(baseTrips).slice(0, maxPoints);

      // Compute whether each point is in the current selection ranges
      const inSel = (d) => inRange(d.trip_distance, state.distanceRange) && inRange(d.total_amount, state.fareRange);

      const sel = gPoints.selectAll("circle").data(trips, (d) => d.id);

      sel.join(
        (enter) => enter.append("circle")
          .attr("cx", (d) => x(d.trip_distance))
          .attr("cy", (d) => y(d.total_amount))
          .attr("r", 2.2)
          .attr("fill", (d) => (inSel(d) ? color(d.payment_type) : "rgba(60,64,67,0.20)"))
          .attr("opacity", (d) => (inSel(d) ? 0.75 : 0.22))
          .style("cursor", "help")
          .on("mouseenter", (event, d) => {
            showTooltip(
              `<div class="tt-title">Trip sample</div>
               <div><strong>${d3.timeFormat("%b %d %Y, %H:%M")(d.pickup_dt)}</strong></div>
               <div>Distance: <strong>${fmt1(d.trip_distance)}</strong> mi</div>
               <div>Duration: <strong>${fmt1(d.duration_min)}</strong> min</div>
               <div>Total: <strong>$${fmt2(d.total_amount)}</strong> (tip $${fmt2(d.tip_amount)})</div>
               <div>Payment: <strong>${paymentLabel(d.payment_type)}</strong></div>
               <div>PU: <strong>${d.PULocationID}</strong> → DO: <strong>${d.DOLocationID}</strong></div>`,
              event.clientX,
              event.clientY
            );
          })
          .on("mousemove", (event) => showTooltip(tooltip.html(), event.clientX, event.clientY))
          .on("mouseleave", hideTooltip),
        (update) => update
          .attr("cx", (d) => x(d.trip_distance))
          .attr("cy", (d) => y(d.total_amount))
          .attr("fill", (d) => (inSel(d) ? color(d.payment_type) : "rgba(60,64,67,0.20)"))
          .attr("opacity", (d) => (inSel(d) ? 0.75 : 0.22)),
        (exit) => exit.remove()
      );

      // Scatter brush interactions
      brush.on("end", (event) => {
        if (suppressBrush) return;

        if (!event.selection) {
          // Clear both ranges
          setState({ distanceRange: null, fareRange: null });
          return;
        }
        const [[x0, y0], [x1, y1]] = event.selection;
        const d0 = x.invert(x0);
        const d1 = x.invert(x1);
        const t0 = y.invert(y1); // y inverted
        const t1 = y.invert(y0);

        setState({
          distanceRange: [Math.max(0, Math.min(d0, d1)), Math.max(0, Math.max(d0, d1))],
          fareRange: [Math.max(0, Math.min(t0, t1)), Math.max(0, Math.max(t0, t1))],
        });
      });

      brushG.call(brush);

      // Programmatic brush move to reflect state ranges (bidirectional with histogram)
      suppressBrush = true;
      if (state.distanceRange || state.fareRange) {
        const dx = state.distanceRange ?? x.domain();
        const ty = state.fareRange ?? y.domain();
        brushG.call(brush.move, [
          [x(dx[0]), y(ty[1])],
          [x(dx[1]), y(ty[0])],
        ]);
      } else {
        brushG.call(brush.move, null);
      }
      suppressBrush = false;

      // Double-click clears scatter selection quickly
      svg.on("dblclick", (event) => {
        event.preventDefault();
        setState({ distanceRange: null, fareRange: null });
      });

      // Legend
      const legend = g.selectAll("g.legend").data([1]);
      const lg = legend.join((enter) => enter.append("g").attr("class", "legend"));
      lg.attr("transform", `translate(${innerW - 2}, 2)`);

      const items = payTypes.map((pt) => ({ pt, label: paymentLabel(pt), color: color(pt) }));
      const li = lg.selectAll("g.item").data(items, (d) => d.pt);
      const liEnter = li.enter().append("g").attr("class", "item");

      liEnter.append("circle").attr("r", 4).attr("cx", -8).attr("cy", 0);
      liEnter.append("text").attr("x", -18).attr("y", 4).attr("text-anchor", "end")
        .attr("fill", "rgba(60,64,67,0.75)").attr("font-size", 11);

      liEnter.merge(li)
        .attr("transform", (d, i) => `translate(0, ${i * 14})`)
        .style("cursor", "pointer")
        .on("click", (event, d) => {
          const same = state.paymentType !== "all" && +state.paymentType === d.pt;
          setState({ paymentType: same ? "all" : String(d.pt) });
          d3.select("#paymentSelect").property("value", same ? "all" : String(d.pt));
        });

      liEnter.merge(li).select("circle").attr("fill", (d) => d.color).attr("opacity", 0.85);
      liEnter.merge(li).select("text").text((d) => d.label);

      li.exit().remove();
    }

    return { resize, update };
  }

  // Histogram: trip distance distribution (brushX)
  function HistogramChart(svgSel) {
    const margin = { top: 16, right: 18, bottom: 42, left: 52 };
    const height = 240;
    let width = 600;

    const svg = svgSel;
    const g = svg.append("g");
    const gAxisX = g.append("g").attr("class", "axis axis-x");
    const gAxisY = g.append("g").attr("class", "axis axis-y");
    const gBars = g.append("g");
    const brushG = g.append("g").attr("class", "brush");

    const x = d3.scaleLinear();
    const y = d3.scaleLinear();

    const brush = d3.brushX();
    let suppressBrush = false;

    function resize() {
      width = Math.max(420, svg.node().clientWidth || 600);
      svg.attr("viewBox", [0, 0, width, height]);

      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      g.attr("transform", `translate(${margin.left},${margin.top})`);

      x.range([0, innerW]);
      y.range([innerH, 0]);

      brush.extent([[0, 0], [innerW, innerH]]);
      brushG.call(brush);

      update();
    }

    function update() {
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const baseTrips = filterSampleTrips(); // includes current payment filter (consistent with other charts)

      const values = baseTrips.map((d) => d.trip_distance).filter((v) => Number.isFinite(v));
      values.sort(d3.ascending);

      const xMax = d3.quantileSorted(values, 0.99) || d3.max(values) || 10;
      x.domain([0, Math.ceil(xMax * 1.02)]).nice();

      const bins = d3.bin()
        .domain(x.domain())
        .thresholds(24)(values);

      y.domain([0, d3.max(bins, (b) => b.length) || 1]).nice();

      gAxisX.attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(6));
      gAxisY.call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~s")));

      // Label
      const xLab = g.selectAll("text.xlab").data([1]);
      xLab.join(
        (enter) => enter.append("text")
          .attr("class", "xlab")
          .attr("x", innerW)
          .attr("y", innerH + 34)
          .attr("text-anchor", "end")
          .attr("fill", "rgba(60,64,67,0.80)")
          .attr("font-size", 12)
          .text("Trip distance (miles)")
      );

      // bars
      const bars = gBars.selectAll("rect").data(bins, (d) => d.x0);

      bars.join(
        (enter) => enter.append("rect")
          .attr("x", (d) => x(d.x0) + 1)
          .attr("y", (d) => y(d.length))
          .attr("width", (d) => Math.max(0, x(d.x1) - x(d.x0) - 1))
          .attr("height", (d) => innerH - y(d.length))
          .attr("fill", "rgba(26,115,232,0.25)")
          .attr("stroke", "rgba(26,115,232,0.80)")
          .attr("stroke-width", 0.6)
          .style("cursor", "pointer")
          .on("mouseenter", (event, d) => {
            showTooltip(
              `<div class="tt-title">Distance bin</div>
               <div>${fmt1(d.x0)}–${fmt1(d.x1)} mi</div>
               <div><strong>${fmtInt(d.length)}</strong> trips</div>
               <div style="margin-top:6px;color:rgba(95,99,104,0.75)">Brush to filter distance</div>`,
              event.clientX,
              event.clientY
            );
          })
          .on("mousemove", (event) => showTooltip(tooltip.html(), event.clientX, event.clientY))
          .on("mouseleave", hideTooltip),
        (update) => update
          .attr("x", (d) => x(d.x0) + 1)
          .attr("y", (d) => y(d.length))
          .attr("width", (d) => Math.max(0, x(d.x1) - x(d.x0) - 1))
          .attr("height", (d) => innerH - y(d.length)),
        (exit) => exit.remove()
      );

      // Brush -> update state.distanceRange
      brush.on("end", (event) => {
        if (suppressBrush) return;

        if (!event.selection) {
          setState({ distanceRange: null });
          return;
        }
        const [px0, px1] = event.selection;
        const d0 = x.invert(px0);
        const d1 = x.invert(px1);
        setState({ distanceRange: [Math.max(0, Math.min(d0, d1)), Math.max(0, Math.max(d0, d1))] });
      });

      brushG.call(brush);

      // Programmatic brush move (bidirectional with scatterplot)
      suppressBrush = true;
      if (state.distanceRange) {
        brushG.call(brush.move, [x(state.distanceRange[0]), x(state.distanceRange[1])]);
      } else {
        brushG.call(brush.move, null);
      }
      suppressBrush = false;

      svg.on("dblclick", (event) => {
        event.preventDefault();
        setState({ distanceRange: null });
      });
    }

    return { resize, update };
  }

  // Box plot: total amount by payment type (ignores payment filter for comparison)
  function BoxPlotChart(svgSel) {
    const margin = { top: 18, right: 16, bottom: 44, left: 52 };
    const height = 260;
    let width = 600;

    const svg = svgSel;
    const g = svg.append("g");
    const gAxisX = g.append("g").attr("class", "axis axis-x");
    const gAxisY = g.append("g").attr("class", "axis axis-y");
    const gBoxes = g.append("g");

    const x = d3.scaleBand().paddingInner(0.38).paddingOuter(0.16);
    const y = d3.scaleLinear();

    function computeStats(trips) {
      const groups = d3.group(trips, (d) => d.payment_type);
      const stats = [];
      for (const [pt, vals] of groups.entries()) {
        const arr = vals.map((d) => d.total_amount).filter((v) => Number.isFinite(v)).sort(d3.ascending);
        if (arr.length < 10) continue;

        const q1 = d3.quantileSorted(arr, 0.25);
        const median = d3.quantileSorted(arr, 0.5);
        const q3 = d3.quantileSorted(arr, 0.75);
        const iqr = q3 - q1;
        const lo = Math.max(arr[0], q1 - 1.5 * iqr);
        const hi = Math.min(arr[arr.length - 1], q3 + 1.5 * iqr);

        stats.push({ pt, n: arr.length, q1, median, q3, lo, hi, mean: d3.mean(arr) });
      }

      // Ensure consistent order
      stats.sort((a, b) => d3.ascending(a.pt, b.pt));
      return stats;
    }

    function resize() {
      width = Math.max(420, svg.node().clientWidth || 600);
      svg.attr("viewBox", [0, 0, width, height]);

      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      g.attr("transform", `translate(${margin.left},${margin.top})`);
      x.range([0, innerW]);

      update();
    }

    function update() {
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      // ignorePayment=true for comparison across payment types
      const trips = filterSampleTrips(true);

      const stats = computeStats(trips);
      const pts = stats.map((d) => d.pt);

      x.domain(pts);
      const yMax = d3.max(stats, (d) => d.hi) || 1;
      y.domain([0, yMax * 1.06]).nice().range([innerH, 0]);

      gAxisX.attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).tickFormat((pt) => {
          const lab = paymentLabel(pt);
          return lab.length > 10 ? lab.slice(0, 10) + "…" : lab;
        }));
      gAxisY.call(d3.axisLeft(y).ticks(5));

      const groups = gBoxes.selectAll("g.box").data(stats, (d) => d.pt);

      const groupsEnter = groups.enter().append("g").attr("class", "box").style("cursor", "pointer");
      groupsEnter.append("line").attr("class", "whisker");
      groupsEnter.append("line").attr("class", "whisker-top");
      groupsEnter.append("line").attr("class", "whisker-bot");
      groupsEnter.append("rect").attr("class", "boxrect").attr("rx", 6);
      groupsEnter.append("line").attr("class", "median");

      const merged = groupsEnter.merge(groups);

      merged
        .attr("transform", (d) => `translate(${x(d.pt)},0)`)
        .on("mouseenter", (event, d) => {
          showTooltip(
            `<div class="tt-title">${paymentLabel(d.pt)}</div>
             <div><strong>${fmtInt(d.n)}</strong> trips (sample)</div>
             <div>Median: <strong>$${fmt2(d.median)}</strong></div>
             <div>IQR: $${fmt2(d.q1)}–$${fmt2(d.q3)}</div>
             <div>Whiskers: $${fmt2(d.lo)}–$${fmt2(d.hi)}</div>
             <div style="margin-top:6px;color:rgba(95,99,104,0.75)">Click to filter payment type</div>`,
            event.clientX,
            event.clientY
          );
        })
        .on("mousemove", (event) => showTooltip(tooltip.html(), event.clientX, event.clientY))
        .on("mouseleave", hideTooltip)
        .on("click", (event, d) => {
          const same = state.paymentType !== "all" && +state.paymentType === d.pt;
          setState({ paymentType: same ? "all" : String(d.pt) });
          d3.select("#paymentSelect").property("value", same ? "all" : String(d.pt));
        });

      const bw = x.bandwidth();

      merged.select("line.whisker")
        .attr("x1", bw / 2).attr("x2", bw / 2)
        .attr("y1", (d) => y(d.lo)).attr("y2", (d) => y(d.hi))
        .attr("stroke", "rgba(60,64,67,0.55)");

      merged.select("line.whisker-top")
        .attr("x1", bw * 0.25).attr("x2", bw * 0.75)
        .attr("y1", (d) => y(d.hi)).attr("y2", (d) => y(d.hi))
        .attr("stroke", "rgba(60,64,67,0.55)");

      merged.select("line.whisker-bot")
        .attr("x1", bw * 0.25).attr("x2", bw * 0.75)
        .attr("y1", (d) => y(d.lo)).attr("y2", (d) => y(d.lo))
        .attr("stroke", "rgba(60,64,67,0.55)");

      merged.select("rect.boxrect")
        .attr("x", 0)
        .attr("y", (d) => y(d.q3))
        .attr("width", bw)
        .attr("height", (d) => Math.max(1, y(d.q1) - y(d.q3)))
        .attr("fill", (d) => {
          const selected = (state.paymentType !== "all" && +state.paymentType === d.pt);
          return selected ? "rgba(26,115,232,0.24)" : "rgba(26,115,232,0.18)";
        })
        .attr("stroke", (d) => {
          const selected = (state.paymentType !== "all" && +state.paymentType === d.pt);
          return selected ? "rgba(26,115,232,0.90)" : "rgba(26,115,232,0.60)";
        });

      merged.select("line.median")
        .attr("x1", 0).attr("x2", bw)
        .attr("y1", (d) => y(d.median)).attr("y2", (d) => y(d.median))
        .attr("stroke", "rgba(60,64,67,0.85)")
        .attr("stroke-width", 2);

      groups.exit().remove();

      // label y-axis
      const yLab = g.selectAll("text.ylab").data([1]);
      yLab.join(
        (enter) => enter.append("text")
          .attr("class", "ylab")
          .attr("x", 0)
          .attr("y", -6)
          .attr("text-anchor", "start")
          .attr("fill", "rgba(60,64,67,0.80)")
          .attr("font-size", 12)
          .text("Total amount ($)")
      );
    }

    return { resize, update };
  }

  // Sankey: pickup->dropoff corridors under current filters
  function SankeyChart(svgSel) {
    const margin = { top: 10, right: 10, bottom: 10, left: 10 };
    const height = 380;
    let width = 900;

    const svg = svgSel;
    const g = svg.append("g");
    const gLinks = g.append("g");
    const gNodes = g.append("g");

    function resize() {
      width = Math.max(480, svg.node().clientWidth || 900);
      svg.attr("viewBox", [0, 0, width, height]);
      g.attr("transform", `translate(${margin.left},${margin.top})`);
      update();
    }

    function update() {
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      // Use the fully filtered trips
      const trips = filterSampleTrips();

      // Aggregate PU->DO counts
      const counts = new Map();
      for (const d of trips) {
        const k = `${d.PULocationID}|${d.DOLocationID}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }

      let flows = Array.from(counts, ([k, v]) => {
        const [pu, do_] = k.split("|").map((x) => +x);
        return { pu, do: do_, value: v };
      });

      // Keep top N flows for readability
      flows.sort((a, b) => d3.descending(a.value, b.value));
      flows = flows.slice(0, 24);

      // Build node sets
      const puSet = new Set(flows.map((f) => f.pu));
      const doSet = new Set(flows.map((f) => f.do));

      const nodes = [];
      const index = new Map();

      function addNode(side, id) {
        const key = `${side}-${id}`;
        if (index.has(key)) return index.get(key);
        const idx = nodes.length;
        index.set(key, idx);
        nodes.push({ name: `${side.toUpperCase()} ${id}`, side, id });
        return idx;
      }

      const links = flows.map((f) => ({
        source: addNode("pu", f.pu),
        target: addNode("do", f.do),
        value: f.value,
        pu: f.pu,
        do: f.do,
      }));

      // Clear if no data
      if (!nodes.length || !links.length) {
        gLinks.selectAll("*").remove();
        gNodes.selectAll("*").remove();
        return;
      }

      const sankey = d3.sankey()
        .nodeWidth(14)
        .nodePadding(12)
        .extent([[0, 0], [innerW, innerH]]);

      const graph = sankey({
        nodes: nodes.map((d) => ({ ...d })),
        links: links.map((d) => ({ ...d })),
      });

      // Draw links
      const linkSel = gLinks.selectAll("path").data(graph.links, (d) => `${d.source.name}-${d.target.name}`);

      linkSel.join(
        (enter) => enter.append("path")
          .attr("d", d3.sankeyLinkHorizontal())
          .attr("fill", "none")
          .attr("stroke", "rgba(26,115,232,0.35)")
          .attr("stroke-width", (d) => Math.max(1, d.width))
          .attr("stroke-linecap", "round")
          .style("mix-blend-mode", "multiply")
          .style("cursor", "help")
          .on("mouseenter", (event, d) => {
            showTooltip(
              `<div class="tt-title">Corridor</div>
               <div><strong>${d.source.name}</strong> → <strong>${d.target.name}</strong></div>
               <div><strong>${fmtInt(d.value)}</strong> trips (sample)</div>
               <div style="margin-top:6px;color:rgba(95,99,104,0.75)">Click a node to filter PU/DO</div>`,
              event.clientX,
              event.clientY
            );
          })
          .on("mousemove", (event) => showTooltip(tooltip.html(), event.clientX, event.clientY))
          .on("mouseleave", hideTooltip),
        (update) => update
          .attr("d", d3.sankeyLinkHorizontal())
          .attr("stroke-width", (d) => Math.max(1, d.width)),
        (exit) => exit.remove()
      );

      // Draw nodes
      const nodeSel = gNodes.selectAll("g.node").data(graph.nodes, (d) => d.name);

      const nodeEnter = nodeSel.enter().append("g").attr("class", "node").style("cursor", "pointer");
      nodeEnter.append("rect").attr("rx", 6);
      nodeEnter.append("text").attr("dy", "0.35em").attr("font-size", 11).attr("fill", "rgba(60,64,67,0.85)");

      const nodeMerged = nodeEnter.merge(nodeSel);

      nodeMerged.select("rect")
        .attr("x", (d) => d.x0)
        .attr("y", (d) => d.y0)
        .attr("width", (d) => d.x1 - d.x0)
        .attr("height", (d) => Math.max(1, d.y1 - d.y0))
        .attr("fill", (d) => d.side === "pu" ? "rgba(26,115,232,0.38)" : "rgba(60,64,67,0.18)")
        .attr("stroke", (d) => {
          const selected = (d.side === "pu" && state.pu === d.id) || (d.side === "do" && state.do === d.id);
          return selected ? "rgba(0,0,0,0.95)" : "rgba(60,64,67,0.24)";
        })
        .attr("stroke-width", (d) => {
          const selected = (d.side === "pu" && state.pu === d.id) || (d.side === "do" && state.do === d.id);
          return selected ? 2 : 1;
        });

      nodeMerged.select("text")
        .attr("x", (d) => d.x0 < innerW / 2 ? d.x1 + 6 : d.x0 - 6)
        .attr("y", (d) => (d.y0 + d.y1) / 2)
        .attr("text-anchor", (d) => d.x0 < innerW / 2 ? "start" : "end")
        .text((d) => d.name);

      nodeMerged
        .on("mouseenter", (event, d) => {
          const selected = (d.side === "pu" && state.pu === d.id) || (d.side === "do" && state.do === d.id);
          showTooltip(
            `<div class="tt-title">${d.name}</div>
             <div>Side: <strong>${d.side.toUpperCase()}</strong></div>
             <div style="margin-top:6px;color:rgba(95,99,104,0.75)">
               Click to ${selected ? "clear" : "set"} ${d.side.toUpperCase()} filter
             </div>`,
            event.clientX,
            event.clientY
          );
        })
        .on("mousemove", (event) => showTooltip(tooltip.html(), event.clientX, event.clientY))
        .on("mouseleave", hideTooltip)
        .on("click", (event, d) => {
          if (d.side === "pu") {
            const same = state.pu === d.id;
            setState({ pu: same ? null : d.id });
          } else {
            const same = state.do === d.id;
            setState({ do: same ? null : d.id });
          }
        });

      nodeSel.exit().remove();
    }

    return { resize, update };
  }

  // ---------- Wiring ----------
  const timeChart = TimeSeriesChart(d3.select("#timeSvg"));
  const scatterChart = ScatterChart(d3.select("#scatterSvg"));
  const histChart = HistogramChart(d3.select("#histSvg"));
  const heatChart = HeatmapChart(d3.select("#heatSvg"));
  const boxChart = BoxPlotChart(d3.select("#boxSvg"));
  const sankeyChart = SankeyChart(d3.select("#sankeySvg"));

  function resizeAll() {
    timeChart.resize();
    scatterChart.resize();
    histChart.resize();
    heatChart.resize();
    boxChart.resize();
    sankeyChart.resize();
  }

  function updateAll() {
    // Update readout first (uses filtered sample)
    updateReadout(filterSampleTrips());
    timeChart.update();
    heatChart.update();
    scatterChart.update();
    histChart.update();
    boxChart.update();
    sankeyChart.update();
  }

  function setState(patch) {
    Object.assign(state, patch);
    updateAll();
  }

  // Controls
  d3.select("#paymentSelect").on("change", function () {
    setState({ paymentType: this.value });
  });

  d3.select("#resetBtn").on("click", () => {
    setState({
      dateRange: null,
      distanceRange: null,
      fareRange: null,
      paymentType: "all",
      dow: null,
      hour: null,
      pu: null,
      do: null,
    });
    d3.select("#paymentSelect").property("value", "all");
  });

  // ---------- Load data ----------
  Promise.all([
    d3.csv("data/daily.csv", (d) => ({
      date: parseDay(d.date),
      trips: +d.trips,
      avg_distance: +d.avg_distance,
      avg_total: +d.avg_total,
      avg_tip: +d.avg_tip,
      pct_tipped: +d.pct_tipped,
    })),
    d3.csv("data/daily_hour.csv", (d) => ({
      date: parseDay(d.date),
      day_ms: +parseDay(d.date),
      dow: +d.dow,
      hour: +d.hour,
      trips: +d.trips,
      avg_total: +d.avg_total,
      avg_distance: +d.avg_distance,
    })),
    d3.csv("data/sample.csv", (d, i) => {
      const pickup_dt = parseISO(d.pickup_dt_iso);
      const day = d3.timeDay(pickup_dt);
      return {
        id: i,
        pickup_dt,
        day_ms: +day,
        date: d.date,
        hour: +d.hour,
        dow: +d.dow,
        passenger_count: +d.passenger_count,
        trip_distance: +d.trip_distance,
        duration_min: +d.duration_min,
        PULocationID: +d.PULocationID,
        DOLocationID: +d.DOLocationID,
        payment_type: +d.payment_type,
        fare_amount: +d.fare_amount,
        tip_amount: +d.tip_amount,
        total_amount: +d.total_amount,
      };
    }),
    d3.json("data/meta.json"),
  ]).then(([daily, dailyHour, sample, meta]) => {
    DATA.daily = daily.filter((d) => d.date);
    DATA.dailyHour = dailyHour.filter((d) => d.date);
    DATA.sample = sample.filter((d) => d.pickup_dt);

    DATA.meta = meta;

    // Initialize dateRange to full extent
    const extent = d3.extent(DATA.daily, (d) => d.date);
    if (extent[0] && extent[1]) {
      state.dateRange = [dayMs(extent[0]), dayMs(extent[1])];
    }

    resizeAll();
    updateAll();
  }).catch((err) => {
    console.error(err);
    d3.select("#filterReadout").html(`<span class="badge">❌ Data load failed. Check console.</span>`);
  });

  window.addEventListener("resize", () => {
    // Recompute layouts; keep state intact
    resizeAll();
  });

})();
