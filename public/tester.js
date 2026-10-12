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

async function runStep(btnId, statusId, responseId, fn) {
  const btn = $(btnId);
  const statusEl = $(statusId);
  const responseEl = $(responseId);
  btn.disabled = true;
  statusEl.textContent = '';
  responseEl.hidden = true;

  const t0 = performance.now();
  try {
    const { status, body } = await fn();
    const ms = Math.round(performance.now() - t0);
    setStatus(statusEl, status < 400, 'HTTP ' + status + ' · ' + ms + 'ms');
    responseEl.textContent = JSON.stringify(body, null, 2);
    responseEl.hidden = false;
    return { status, body };
  } catch (e) {
    setStatus(statusEl, false, 'Request failed');
    responseEl.textContent = String(e);
    responseEl.hidden = false;
    return null;
  } finally {
    btn.disabled = false;
  }
}

let lastSuggestedInput = null;
let lastGeneratedPlan = null;

$('suggestBtn').addEventListener('click', async () => {
  const result = await runStep('suggestBtn', 'suggestStatus', 'suggestResponse', () =>
    callApi('/api/v1/planner/suggestions', {
      method: 'POST',
      body: JSON.stringify({ prompt: $('prompt').value }),
    })
  );
  if (result && result.body && result.body.data) {
    lastSuggestedInput = result.body.data.input;
  }
});

$('useSuggestionBtn').addEventListener('click', () => {
  if (!lastSuggestedInput) {
    alert('Run Suggest first.');
    return;
  }
  $('generateInput').value = JSON.stringify(lastSuggestedInput, null, 2);
});

$('generateBtn').addEventListener('click', async () => {
  let input;
  try {
    input = JSON.parse($('generateInput').value);
  } catch (e) {
    setStatus($('generateStatus'), false, 'Invalid JSON');
    return;
  }
  const result = await runStep('generateBtn', 'generateStatus', 'generateResponse', () =>
    callApi('/api/v1/planner/plans', { method: 'POST', body: JSON.stringify(input) })
  );
  if (result && result.body && result.body.data) {
    lastGeneratedPlan = result.body.data;
  }
});

$('saveBtn').addEventListener('click', async () => {
  const planId = $('planId').value.trim();
  if (!planId) {
    setStatus($('saveStatus'), false, 'Enter a plan ID first');
    return;
  }
  if (!lastGeneratedPlan) {
    setStatus($('saveStatus'), false, 'Run Generate first');
    return;
  }
  let input;
  try {
    input = JSON.parse($('generateInput').value);
  } catch (e) {
    setStatus($('saveStatus'), false, 'Generate input is invalid JSON');
    return;
  }
  await runStep('saveBtn', 'saveStatus', 'saveResponse', () =>
    callApi('/api/v1/planner/plans/' + encodeURIComponent(planId), {
      method: 'PUT',
      body: JSON.stringify({ input, plan: lastGeneratedPlan }),
    })
  );
});

async function loadPlans() {
  const listEl = $('plansList');
  listEl.innerHTML = '<span class="hint">Loading…</span>';
  try {
    const { status, body } = await callApi('/api/v1/planner/plans?limit=10', { method: 'GET' });
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
      const title = (plan.campaign && plan.campaign.title) || plan.planId;
      const approved = plan.approval && plan.approval.approved;
      row.innerHTML =
        '<span>' + title + (approved ? ' ✓' : '') + '</span>' +
        '<span class="hint">' + plan.planId + ' · ' + (plan.savedAt || '') + '</span>';
      if (!approved) {
        row.style.cursor = 'pointer';
        row.title = 'Click to approve';
        row.addEventListener('click', async () => {
          await callApi('/api/v1/planner/plans/' + encodeURIComponent(plan.planId) + '/approve', { method: 'POST' });
          loadPlans();
        });
      }
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.innerHTML = '<span class="hint">Request failed: ' + e + '</span>';
  }
}

$('refreshPlans').addEventListener('click', loadPlans);
