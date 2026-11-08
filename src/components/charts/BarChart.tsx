import { useEffect, useId, useState } from 'react'
import { cn } from '@/lib/cn'

export interface BarSeries {
  key: string
  label: string
  color: string
  values: number[]
  format: (v: number) => string
}

/**
 * Small dependency-free grouped bar chart. Labels and values are given by the
 * caller; the chart only draws. Keyboard users get a per-bucket summary via
 * the accessible table below the SVG.
 */
export function BarChart({ labels, series, height: maxHeight = 200, className, emptyMessage = 'No data for this period' }: { labels: string[]; series: BarSeries[]; height?: number; className?: string; emptyMessage?: string }) {
  const id = useId()
  const [hover, setHover] = useState<number | null>(null)
  // Measure the container and draw in real pixels, so text never scales down with the chart.
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  const height = width < 480 ? Math.min(maxHeight, 220) : maxHeight
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  const n = labels.length
  const padL = 8
  const padR = 8
  const padT = 12
  const padB = 24
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const groupW = n > 0 ? innerW / n : innerW
  const barGap = 2
  const barW = Math.max(2, (groupW - 6) / series.length - barGap)
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 48))))

  if (max === 0) {
    return (
      <div className={cn('flex items-center justify-center rounded-xl bg-sunken/60 text-sm text-muted', className)} style={{ height }}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <div ref={setEl} className={cn('relative', className)}>
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" style={{ height }} role="img" aria-labelledby={`${id}-title`}>
        <title id={`${id}-title`}>Bar chart of {series.map((s) => s.label).join(' and ')}</title>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={padL} x2={width - padR} y1={padT + innerH - innerH * f} y2={padT + innerH - innerH * f} stroke="rgb(var(--c-line))" strokeWidth={1} />
        ))}
        {labels.map((label, i) => {
          const gx = padL + i * groupW
          return (
            <g key={label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={gx} y={padT} width={groupW} height={innerH} fill={hover === i ? 'rgb(var(--c-sunken))' : 'transparent'} />
              {series.map((s, si) => {
                const v = s.values[i] ?? 0
                const h = max > 0 ? (v / max) * innerH : 0
                const x = gx + 3 + si * (barW + barGap)
                return <rect key={s.key} x={x} y={padT + innerH - h} width={barW} height={h} rx={2} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.6} />
              })}
              {i % tickEvery === 0 ? (
                // Keep the first and last labels inside the drawing: a centred label can hang past the edge.
                <text x={Math.min(width - padR - label.length * 3.4, Math.max(padL + label.length * 3.4, gx + groupW / 2))} y={height - 6} textAnchor="middle" fontSize={11} fontFamily="'IBM Plex Mono', ui-monospace, monospace" fill="rgb(var(--c-faint))">
                  {label}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      {hover !== null ? (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop">
          <p className="font-medium">{labels[hover]}</p>
          {series.map((s) => (
            <p key={s.key} className="tabular flex items-center gap-1.5 text-muted">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
              {s.label}: {s.format(s.values[hover] ?? 0)}
            </p>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>
      <div className="sr-only">
      <table>
        <caption>Chart data</caption>
        <thead>
          <tr>
            <th>Period</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={l}>
              <td>{l}</td>
              {series.map((s) => (
                <td key={s.key}>{s.format(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
