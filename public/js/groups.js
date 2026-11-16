// Subgroups: when the main group splits up. Anyone can make one and move people in or out.
import { state, on, op, emit, userById, tripDays, groupsOn, today } from './store.js';
import { openSheet, esc, icon, avatar, fmtDay, uid, toast, confirmSheet, ago } from './ui.js';

export const GROUP_COLORS = ['#E85298', '#0079C2', '#F39700', '#00A672', '#8F76D6', '#C1A470', '#00AC9B', '#E60012'];

export function groupDays(g) {
  if (!g.startDay) return 'Whole trip';
  if (!g.endDay || g.endDay === g.startDay) return fmtDay(g.startDay);
  return `${fmtDay(g.startDay, { day: 'numeric', month: 'short' })} to ${fmtDay(g.endDay, { day: 'numeric', month: 'short' })}`;
}

// Where is a subgroup right now? Members who share location.
export function groupWhere(g) {
  const locs = g.memberIds.map((id) => state.locations[id]).filter(Boolean);
  if (!locs.length) return { text: 'Nobody in it is sharing location', locs };
  const newest = Math.max(...locs.map((l) => l.ts));
  return { text: `${locs.length} of ${g.memberIds.length} sharing, updated ${ago(newest)}`, locs };
}

let listSheet = null;
on('subgroups', () => listSheet && !listSheet.closed && renderList());
on('locations', () => listSheet && !listSheet.closed && renderList());

export function openGroups() {
  listSheet = openSheet({ title: 'Subgroups', sub: 'For when the group splits up. Anyone can change these.' });
  renderList();
}

function renderList() {
  const s = listSheet;
  const t = today();
  const all = [...state.subgroups].sort((a, b) => (a.startDay || '') < (b.startDay || '') ? -1 : 1);
  s.body.innerHTML = `
    ${all.length ? all.map((g) => {
      const active = groupsOn(t).includes(g);
      const where = groupWhere(g);
      return `<div class="group-card" style="--g:${esc(g.color)}">
        <div class="group-card-head">
          <span class="group-dot"></span>
          <div class="grow"><b>${esc(g.name)}</b><div class="help">${esc(groupDays(g))}${active ? ', active today' : ''}</div></div>
          <button class="btn small" data-edit="${g.id}">Edit</button>
        </div>
        <div class="avatars">${g.memberIds.map((id) => userById(id)).filter(Boolean).map((u) => avatar(u)).join('') || '<span class="faint">No one yet</span>'}</div>
        <div class="help" style="display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:6px">
          <span>${esc(where.text)}</span>
          ${where.locs.length ? `<button class="btn small" data-where="${g.id}">${icon('pin')}Show on map</button>` : ''}
        </div>
      </div>`;
    }).join('') : `<div class="empty" style="margin:10px 0 20px"><p>No subgroups yet. Make one when some of you head off separately, then pick it under “Who’s going” on each stop.</p></div>`}
    <button class="btn primary block" data-new>${icon('plus')}New subgroup</button>`;
  s.body.querySelector('[data-new]').onclick = () => openGroupEditor();
  s.body.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openGroupEditor(state.subgroups.find((g) => g.id === b.dataset.edit)));
  s.body.querySelectorAll('[data-where]').forEach((b) => b.onclick = () => { emit('focus-group', b.dataset.where); emit('go', 'map'); s.close(); });
}

export function openGroupEditor(g) {
  const isNew = !g;
  const days = tripDays();
  const used = new Set(state.subgroups.map((x) => x.color));
  const draft = g ? { ...g, memberIds: [...g.memberIds] } : {
    id: 'g' + uid().slice(1), name: '', color: GROUP_COLORS.find((c) => !used.has(c)) || GROUP_COLORS[0],
    startDay: null, endDay: null, memberIds: state.me ? [state.me.id] : [],
  };
  const dayOpts = (sel, blank) => `<option value="">${blank}</option>${days.map((d) => `<option value="${d}" ${d === sel ? 'selected' : ''}>${esc(fmtDay(d))}</option>`).join('')}`;
  // Who else is in another subgroup on overlapping days, so moving people is obvious
  const otherGroupOf = (userId) => state.subgroups.find((x) => x.id !== draft.id && x.memberIds.includes(userId) &&
    (!x.startDay || !draft.startDay || (x.startDay <= (draft.endDay || draft.startDay) && (x.endDay || x.startDay) >= draft.startDay)));

  const s = openSheet({
    title: isNew ? 'New subgroup' : `Edit ${g.name}`,
    body: `
      <label class="field"><span>Name</span><input class="input" data-name value="${esc(draft.name)}" placeholder="Ramen crew, Hakone day trip…" maxlength="40" ${isNew ? 'autofocus' : ''}></label>
      <div class="field"><span>Colour</span><div class="colors">${GROUP_COLORS.map((c) => `<button class="color-dot" style="--c:${c}" data-color="${c}" aria-label="Colour ${c}" aria-pressed="${c === draft.color}"></button>`).join('')}</div></div>
      <div class="inline-fields">
        <label class="field"><span>From</span><select class="input" data-start>${dayOpts(draft.startDay, 'Whole trip')}</select></label>
        <label class="field"><span>To</span><select class="input" data-end>${dayOpts(draft.endDay, 'Same day')}</select></label>
      </div>
      <div class="field"><span>Who’s in it</span><div class="card" style="margin:0;border:1px solid var(--line)" data-members></div></div>`,
    foot: `${isNew ? '' : `<button class="btn danger" data-delete>${icon('trash')}End subgroup</button>`}<button class="btn primary" data-save>Save</button>`,
  });
  const membersEl = s.el.querySelector('[data-members]');
  const renderMembers = () => {
    membersEl.innerHTML = state.users.map((u) => {
      const other = otherGroupOf(u.id);
      const inIt = draft.memberIds.includes(u.id);
      return `<label class="row member" style="min-height:48px">${avatar(u)}<div class="grow"><div class="label">${esc(u.name)}</div>
        ${other && !inIt ? `<div class="help">In ${esc(other.name)}. Adding moves them here.</div>` : ''}</div>
        <span class="switch"><input type="checkbox" data-member="${u.id}" ${inIt ? 'checked' : ''} aria-label="${esc(u.name)} is in this subgroup"><span></span></span></label>`;
    }).join('');
    membersEl.querySelectorAll('[data-member]').forEach((c) => c.onchange = () => {
      const id = +c.dataset.member;
      draft.memberIds = c.checked ? [...new Set([...draft.memberIds, id])] : draft.memberIds.filter((x) => x !== id);
    });
  };
  renderMembers();
  s.el.querySelectorAll('[data-color]').forEach((b) => b.onclick = () => {
    draft.color = b.dataset.color;
    s.el.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  });
  s.el.querySelector('[data-start]').onchange = (e) => { draft.startDay = e.target.value || null; renderMembers(); };
  s.el.querySelector('[data-end]').onchange = (e) => { draft.endDay = e.target.value || null; renderMembers(); };

  s.el.querySelector('[data-save]').onclick = async () => {
    draft.name = s.el.querySelector('[data-name]').value.trim();
    if (!draft.name) { toast('Give the subgroup a name.'); return; }
    if (draft.endDay && draft.startDay && draft.endDay < draft.startDay) { toast('The last day has to be on or after the first day.'); return; }
    // Someone can only be in one subgroup at a time: take new members out of overlapping groups.
    for (const id of draft.memberIds) {
      const other = otherGroupOf(id);
      if (other) op('group.member', { id: other.id, userId: id, on: false });
    }
    op('group.save', { group: { ...draft, endDay: draft.endDay || draft.startDay } });
    toast(isNew ? `${draft.name} created` : 'Subgroup saved');
    s.close();
  };
  s.el.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: `End ${g.name}?`, body: 'Its stops go back to everyone’s plan. Nothing else is deleted.', confirm: 'End subgroup', danger: true }))) return;
    op('group.delete', { id: g.id });
    s.close();
  });
}
