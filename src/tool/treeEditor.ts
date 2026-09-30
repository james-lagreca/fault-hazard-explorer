// Logic-tree editor: per uncertain input, a switchable list of branches, each a
// value (factor on the slider for slip rate, offset for the rest) and a weight.
// Branches follow the sliders; the "→" column shows what each resolves to now.

import {
  DEFAULT_TREE,
  TREE_MODE,
  TREE_PARAMS,
  bestMmax,
  branchInputValue,
  identityValue,
} from '../engine/uncertainty';
import type { Branch, FaultInputs, LogicTree, TreeParam } from '../engine/uncertainty';

const MAX_BRANCHES = 5;

interface Def {
  label: string;
  /** Short header for the value column. */
  valueHead: string;
  step: number;
  /** Unit of the resolved "→" column. */
  absHead: string;
  /** Format an absolute resolved input for the "→" column (unit in the header). */
  fmtAbs: (v: number) => string;
}

const DEFS: Record<TreeParam, Def> = {
  slip: { label: 'Slip rate', valueHead: '× slider', step: 0.1, absHead: '→ mm/yr', fmtAbs: (v) => v.toPrecision(2) },
  dip: { label: 'Dip', valueHead: '± °', step: 1, absHead: '→ °', fmtAbs: (v) => v.toFixed(0) },
  thickness: { label: 'Seismogenic thickness', valueHead: '± km', step: 1, absHead: '→ km', fmtAbs: (v) => v.toFixed(0) },
  b: { label: 'b-value', valueHead: '± b', step: 0.05, absHead: '→ b', fmtAbs: (v) => v.toFixed(2) },
  mmax: { label: 'M<sub>max</sub>', valueHead: '± M', step: 0.05, absHead: '→ M', fmtAbs: (v) => v.toFixed(2) },
};

const DEFAULT_ON: Record<TreeParam, boolean> = { slip: true, dip: true, thickness: false, b: true, mmax: true };

interface InputState {
  on: boolean;
  branches: Branch[];
}

const state = {} as Record<TreeParam, InputState>;
for (const p of TREE_PARAMS) state[p] = { on: DEFAULT_ON[p], branches: DEFAULT_TREE[p].map((b) => ({ ...b })) };

let root: HTMLElement | null = null;
let notify: () => void = () => {};
let lastInputs: FaultInputs | null = null;

/** The tree as the engine wants it: enabled inputs only. */
export function readTree(): LogicTree {
  const tree: LogicTree = {};
  for (const p of TREE_PARAMS) if (state[p].on) tree[p] = state[p].branches.map((b) => ({ ...b }));
  return tree;
}

const fmtNum = (v: number): string => String(Number(v.toPrecision(6)));

function weightSum(p: TreeParam): number {
  return state[p].branches.reduce((s, b) => s + (Number.isFinite(b.weight) && b.weight > 0 ? b.weight : 0), 0);
}

function sectionHTML(p: TreeParam): string {
  const d = DEFS[p];
  const s = state[p];
  const rows = s.branches
    .map(
      (b, i) => `<tr>
        <td><input type="number" class="ltv" data-p="${p}" data-i="${i}" step="${d.step}" value="${fmtNum(b.value)}"
          aria-label="${d.label.replace(/<[^>]+>/g, '')} branch ${i + 1} value"${TREE_MODE[p] === 'factor' ? ' min="0.01"' : ''}></td>
        <td><input type="number" class="ltw" data-p="${p}" data-i="${i}" step="0.05" min="0" max="1" value="${fmtNum(b.weight)}"
          aria-label="${d.label.replace(/<[^>]+>/g, '')} branch ${i + 1} weight"></td>
        <td class="ltabs" id="ltabs_${p}_${i}">—</td>
        <td><button type="button" class="ltdel" data-p="${p}" data-i="${i}" aria-label="Remove branch ${i + 1}"
          ${s.branches.length <= 1 ? 'disabled' : ''}>×</button></td>
      </tr>`,
    )
    .join('');
  return `<div class="ltsec${s.on ? '' : ' off'}" id="ltsec_${p}">
    <div class="ltrow">
      <label class="ltname"><input type="checkbox" class="lton" data-p="${p}"${s.on ? ' checked' : ''}>${d.label}</label>
      <span class="ltsum" id="ltsum_${p}"></span>
    </div>
    <table class="lttab">
      <thead><tr><th>${d.valueHead}</th><th>weight</th><th>${d.absHead}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <button type="button" class="ltadd" data-p="${p}"${s.branches.length >= MAX_BRANCHES ? ' disabled' : ''}>+ branch</button>
  </div>`;
}

function renderSection(p: TreeParam): void {
  const el = document.getElementById(`ltsec_${p}`);
  if (el) el.outerHTML = sectionHTML(p);
  refreshTreeLabels();
}

/** Update the weight sums, resolved values and branch count (no DOM rebuild). */
export function refreshTreeLabels(fi: FaultInputs | null = lastInputs): void {
  lastInputs = fi;
  let n = 1;
  let any = false;
  for (const p of TREE_PARAMS) {
    const s = state[p];
    const sum = weightSum(p);
    const sumEl = document.getElementById(`ltsum_${p}`);
    if (sumEl) {
      const ok = Math.abs(sum - 1) < 1e-6;
      sumEl.textContent = sum > 0 ? `Σw ${sum.toFixed(2)}${ok ? '' : ' → normalized'}` : 'no valid weights';
      sumEl.classList.toggle('warn', !ok);
    }
    if (s.on) {
      const valid = s.branches.filter((b) => Number.isFinite(b.value) && b.weight > 0).length;
      if (valid > 0) {
        n *= valid;
        any = true;
      }
    }
    if (!fi) continue;
    const mBest = bestMmax(fi);
    s.branches.forEach((b, i) => {
      const cell = document.getElementById(`ltabs_${p}_${i}`);
      if (!cell) return;
      if (!Number.isFinite(b.value)) {
        cell.textContent = '—';
        return;
      }
      const abs = p === 'mmax' ? mBest + b.value : branchInputValue(p, fi, b.value);
      cell.innerHTML = DEFS[p].fmtAbs(abs) + (b.value === identityValue(p) ? ' <span class="u">best</span>' : '');
    });
  }
  const nEl = document.getElementById('vlt_n');
  if (nEl) nEl.textContent = any ? `${n} branch${n === 1 ? '' : 'es'}` : 'no inputs varied';
}

export function initTreeEditor(el: HTMLElement, onChange: () => void): void {
  root = el;
  notify = onChange;
  root.innerHTML = TREE_PARAMS.map(sectionHTML).join('');

  root.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const p = t.dataset.p as TreeParam | undefined;
    if (!p) return;
    const i = Number(t.dataset.i);
    if (t.classList.contains('lton')) {
      state[p].on = t.checked;
      document.getElementById(`ltsec_${p}`)?.classList.toggle('off', !t.checked);
    } else if (t.classList.contains('ltv')) {
      state[p].branches[i]!.value = t.value === '' ? NaN : +t.value;
    } else if (t.classList.contains('ltw')) {
      state[p].branches[i]!.weight = t.value === '' ? NaN : +t.value;
    } else return;
    refreshTreeLabels();
    notify();
  });

  root.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    const p = t.dataset.p as TreeParam | undefined;
    if (!p) return;
    const s = state[p];
    if (t.classList.contains('ltadd') && s.branches.length < MAX_BRANCHES) {
      // New branch: one step beyond the current highest value, zero weight
      // so adding it doesn't change the result until you weight it.
      const top = Math.max(...s.branches.map((b) => (Number.isFinite(b.value) ? b.value : identityValue(p))));
      const value = TREE_MODE[p] === 'factor' ? top * 1.5 : top + DEFS[p].step * 5;
      s.branches.push({ value: Number(value.toPrecision(4)), weight: 0 });
    } else if (t.classList.contains('ltdel') && s.branches.length > 1) {
      s.branches.splice(Number(t.dataset.i), 1);
    } else return;
    renderSection(p);
    notify();
  });
}
