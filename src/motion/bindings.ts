import type { Binding, RowSelector } from '../types'

export function selectRows(sel: RowSelector, rowCount: number, keyRow: number): boolean[] {
  const out = new Array(rowCount).fill(false)
  if (sel === 'all') {
    out.fill(true)
    return out
  }
  if (sel === 'even') {
    for (let i = 0; i < rowCount; i++) out[i] = i % 2 === 0
    return out
  }
  if (sel === 'odd') {
    for (let i = 0; i < rowCount; i++) out[i] = i % 2 === 1
    return out
  }
  if (sel === 'keyRow') {
    if (keyRow >= 0 && keyRow < rowCount) out[keyRow] = true
    return out
  }
  if (Array.isArray(sel)) {
    for (const i of sel) if (i >= 0 && i < rowCount) out[i] = true
    return out
  }
  if (typeof sel === 'function') {
    for (let i = 0; i < rowCount; i++) out[i] = sel(i, rowCount)
    return out
  }
  return out
}

export interface BindingResolved {
  binding: Binding
  rows: boolean[]
}

export function resolveBindings(bindings: Binding[], rowCount: number, keyRow: number): BindingResolved[] {
  return bindings.map((b) => {
    // Camera-targeted bindings have no row scope.
    if ((b.target ?? 'rows') === 'camera') {
      return { binding: b, rows: new Array(rowCount).fill(false) }
    }
    return { binding: b, rows: selectRows(b.rows ?? 'all', rowCount, keyRow) }
  })
}
