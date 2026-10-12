const $ = id => document.getElementById(id);
const tokenInput = $('token');
tokenInput.value = localStorage.getItem('spendoptix_token') || '';
tokenInput.addEventListener('input', () => localStorage.setItem('spendoptix_token', tokenInput.value.trim()));

function setStatus(el, ok, text) {
  el.textContent = '';
  const span = document.createElement('span');
  span.className = 'status ' + (ok ? 'ok' : 'err');
  span.textContent = text;
  el.appendChild(span);
}

async function callApi(path, options) {
  const token = tokenInput.value.trim();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options && options.headers),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

$('analyseBtn').addEventListener('click', async () => {
  const btn = $('analyseBtn');
  const statusEl = $('analyseStatus');
  const responseEl = $('analyseResponse');
  btn.disabled = true;
  statusEl.textContent = '';
  responseEl.hidden = true;

  const splitList = value => value.split(',').map(s => s.trim()).filter(Boolean);
  const payload = {
    brief: $('brief').value,
    // Empty selection means "auto-detect" — omit the field entirely so the backend
    // classifies it, rather than sending an empty string that'd fail validation.
    type: $('type').value || undefined,
    context: {
      country: 'IN',
      channels: splitList($('channels').value),
      objectives: splitList($('objectives').value),
      kpis: splitList($('kpis').value),
    },
  };

  const t0 = performance.now();
  try {
    const { status, body } = await callApi('/plan/analyse', { method: 'POST', body: JSON.stringify(payload) });
    const ms = Math.round(performance.now() - t0);
    setStatus(statusEl, status < 400, 'HTTP ' + status + ' · ' + ms + 'ms');
    responseEl.textContent = JSON.stringify(body, null, 2);
    responseEl.hidden = false;
  } catch (e) {
    setStatus(statusEl, false, 'Request failed');
    responseEl.textContent = String(e);
    responseEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function loadPlans() {
  const listEl = $('plansList');
  listEl.innerHTML = '<span class="hint">Loading…</span>';
  try {
    const { status, body } = await callApi('/media-plans?limit=10', { method: 'GET' });
    if (status >= 400) {
      listEl.innerHTML = '<span class="hint">HTTP ' + status + ' — ' + (body && body.message || 'failed') + '</span>';
      return;
    }
    const plans = (body && body.data) || [];
    if (plans.length === 0) {
      listEl.innerHTML = '<span class="hint">No saved plans yet.</span>';
      return;
    }
    listEl.innerHTML = '';
    for (const plan of plans) {
      const row = document.createElement('div');
      row.className = 'plan-row';
      const name = (plan.campaign && plan.campaign.name) || plan.planId;
      row.innerHTML = '<span>' + name + '</span><span class="hint">' + plan.planId + ' · ' + (plan.savedAt || '') + '</span>';
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.innerHTML = '<span class="hint">Request failed: ' + e + '</span>';
  }
}

$('refreshPlans').addEventListener('click', loadPlans);
