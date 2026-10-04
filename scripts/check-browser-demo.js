// Run against `npm run preview --workspace=web` with:
// npx agent-browser open http://localhost:4173
// npx agent-browser eval --stdin < scripts/check-browser-demo.js
(async () => {
  const engine = await import('/demo/engine.js');
  const before = await engine.exportDemo();
  const passed = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const call = async (method, path, body) => {
    const response = await engine.request(method, path, body);
    const result = await response.json();
    assert(response.ok, `${method} ${path}: ${result.error}`);
    return result;
  };
  try {
    const overview = await call('GET', '/erp/overview');
    const plan = overview.work_items[0], crew = overview.crews[0];
    const report = await call('POST', '/erp/daily-reports', {
      jobsite_id: plan.jobsite_id, crew_id: crew.id, date: '2026-10-03', status: 'draft',
      weather: 'Clear', notes: 'Browser demo verification', created_by: 'Demo tester',
      client_request_id: crypto.randomUUID(), lines: [{ plan_id: plan.id, qty: 1, labor_hours: 0 }],
    });
    let refreshed = await call('GET', '/erp/overview');
    assert(refreshed.work_items.find(row => row.id === plan.id).actual_qty === plan.actual_qty, 'A draft incorrectly changed measured work');
    await call('POST', `/erp/daily-reports/${report.id}/submit`);
    await call('POST', `/erp/daily-reports/${report.id}/approve`, { approved_by: 'Demo reviewer' });
    refreshed = await call('GET', '/erp/overview');
    assert(refreshed.work_items.find(row => row.id === plan.id).actual_qty === plan.actual_qty + 1, 'Approved work did not post');
    passed.push('Draft → submit → approve updates measured work');
    const rejected = await engine.request('PATCH', `/erp/daily-reports/${report.id}`, { notes: 'Change approved report' });
    assert(!rejected.ok, 'Approved report allowed editing');
    passed.push('Approved reports retain existing workflow guards');
    const doc = await call('POST', '/erp/documents', {
      jobsite_id: plan.jobsite_id, name: 'demo-test.txt', mime_type: 'text/plain',
      category: 'other', description: 'Local attachment verification', base64: btoa('Persisted local attachment'),
    });
    const archive = await engine.exportDemo();
    await engine.resetDemo();
    assert(!(await call('GET', '/erp/documents')).documents.some(row => row.id === doc.id), 'Reset retained attachment metadata');
    await engine.importDemo(archive);
    const download = await engine.request('GET', `/erp/documents/${doc.id}/download`);
    assert(download.ok && await download.text() === 'Persisted local attachment', 'Attachment bytes did not survive export/import');
    passed.push('Attachments and records survive export → reset → import');
    const originalPut = IDBObjectStore.prototype.put;
    try {
      IDBObjectStore.prototype.put = function () { throw new DOMException('Simulated full storage', 'QuotaExceededError'); };
      const failed = await engine.request('POST', '/erp/people', { name: 'Unsaved person', role: 'operator', active: 1 });
      assert(!failed.ok, 'Storage failure incorrectly reported success');
    } finally { IDBObjectStore.prototype.put = originalPut; }
    assert(!(await call('GET', '/erp/overview')).people.some(row => row.name === 'Unsaved person'), 'Failed save changed persisted records');
    passed.push('Failed browser storage writes roll back');
    const frame = document.createElement('iframe'); frame.style.display = 'none'; document.body.appendChild(frame);
    try {
      const other = await frame.contentWindow.eval(`import('${location.origin}/demo/engine.js')`);
      await Promise.all([
        call('POST', '/erp/people', { name: 'Tab one person', role: 'operator', active: 1 }),
        other.request('POST', '/erp/people', { name: 'Tab two person', role: 'operator', active: 1 }).then(async response => assert(response.ok, await response.text())),
      ]);
      const people = (await call('GET', '/erp/overview')).people;
      assert(people.some(row => row.name === 'Tab one person') && people.some(row => row.name === 'Tab two person'), 'Concurrent contexts overwrote records');
      passed.push('Concurrent browser contexts preserve both edits');
    } finally { frame.remove(); }
    for (const path of ['/erp/estimating', '/erp/workforce-planning', '/erp/equipment-operations', '/erp/commercial', '/erp/procurement', '/erp/project-finance', '/assets/state', '/ai/projections', '/safety/summary']) await call('GET', path);
    passed.push('All major module reads succeed');
    return passed;
  } finally { await engine.importDemo(before); }
})()
