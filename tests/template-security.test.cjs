const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sanitizeTemplateHtml, renderTemplate } = require("../lib/template-utils.ts");
const { db } = require("../lib/db.ts");
const { createTemplateVersion } = require("../lib/data/templates.ts");
const { sendTestEmail } = require("../lib/data/notifications.ts");

test("all 15 seeded global templates survive the allow-list unchanged", () => {
  const source = fs.readFileSync(path.join(__dirname, "../prisma/seed.ts"), "utf8");
  const templatesBlock = source.split("const TEMPLATES:")[1].split("  ];")[0];
  const bodies = [...templatesBlock.matchAll(/bodyHtml:\s*`([\s\S]*?)`/g)].map((match) => match[1]);
  assert.equal(bodies.length, 15, "seed should contain exactly 15 global templates");
  const normalize = (html) => html
    .replace(/&mdash;/g, "—")
    .replace(/<br\s*\/>/g, "<br>")
    .replace(/\s*\/>/g, ">")
    .replace(/;(?=[\"'])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const diffs = bodies.map((body, index) => ({ template: index + 1, before: body, after: sanitizeTemplateHtml(body) }))
    .filter((entry) => normalize(entry.before) !== normalize(entry.after));
  assert.deepEqual(diffs, [], JSON.stringify(diffs, null, 2));
  for (const [index] of bodies.entries()) console.log(`RAW seeded template ${index + 1}: before/after equivalent; only sanitizer serialization whitespace/semicolon normalization`);
});

test("template sanitizer strips executable markup, unsafe links and CSS tricks", () => {
  const attack = '<p style="color:red;background:url(javascript:alert(1))">ok</p><script>alert(1)</script><img src="https://safe.test/x" onerror="alert(1)"><a href="javascript:alert(1)">click</a><iframe src="https://evil.test"></iframe><svg onload="alert(1)"></svg><p style="position:fixed;behavior:url(x);color:expression(alert(1))">x</p>';
  const clean = sanitizeTemplateHtml(attack);
  console.log("RAW sanitizer attack output:", clean);
  assert.equal(clean.includes("<script"), false);
  assert.equal(clean.includes("onerror"), false);
  assert.equal(/href="javascript:/i.test(clean), false);
  assert.equal(clean.includes("<iframe"), false);
  assert.equal(clean.includes("<svg"), false);
  assert.equal(clean.includes("position:"), false);
  assert.equal(clean.includes("behavior:"), false);
  assert.equal(clean.includes("expression"), false);
  assert.match(clean, /<img src="https:\/\/safe\.test\/x" \/>/);
  assert.equal(sanitizeTemplateHtml('<img src="http://unsafe.test/image.png">'), "<img />");
});

test("placeholders survive saving and substituted body values are HTML escaped", () => {
  const raw = '<p>Hi {{participant_name}}</p><a href="{{booking_link}}">book</a>';
  const saved = sanitizeTemplateHtml(raw);
  assert.equal(saved, raw);
  const rendered = renderTemplate({ subject: "Hi {{participant_name}}", bodyHtml: saved }, {
    participant_name: '<a href=https://evil.test>x</a>', booking_link: "https://example.test/book?x=1&y=2",
  });
  assert.equal(rendered.subject, "Hi <a href=https://evil.test>x</a>");
  assert.equal(rendered.bodyHtml, '<p>Hi &lt;a href=https://evil.test&gt;x&lt;/a&gt;</p><a href="https://example.test/book?x=1&amp;y=2">book</a>');
  assert.equal(renderTemplate({ subject: "link", bodyHtml: '<a href="{{booking_link}}">go</a>' }, { booking_link: "javascript:alert(1)" }).bodyHtml, "<a>go</a>");
  for (const audience of ["participant", "admin", "super_admin"]) {
    const message = renderTemplate({ subject: "Booking {{participant_name}}", bodyHtml: "<p>{{participant_name}}</p>" }, { participant_name: "<a href=https://evil.test>x</a>" });
    assert.equal(message.bodyHtml, "<p>&lt;a href=https://evil.test&gt;x&lt;/a&gt;</p>", `${audience} message`);
    console.log(`RAW ${audience} email attack before: <p><a href=https://evil.test>x</a></p>; after: ${message.bodyHtml}`);
  }
  assert.equal(renderTemplate({ subject: "x\r\nBcc: victim", bodyHtml: "{{participant_name}}" }, { participant_name: "O'Brien Zoë", }).bodyHtml, "O'Brien Zoë");
  assert.equal(renderTemplate({ subject: "{{participant_name}}", bodyHtml: "" }, { participant_name: "victim\r\nBcc: injected" }).subject, "victimBcc: injected");
  assert.equal(renderTemplate({ subject: "safe\r\nBcc: injected", bodyHtml: "" }, {}).subject, "safeBcc: injected");
});

test("both template previews use empty sandboxed srcDoc iframes", () => {
  for (const file of ["TemplateEditForm.tsx", "TemplateForm.tsx"]) {
    const source = fs.readFileSync(path.join(__dirname, "../components", file), "utf8");
    assert.match(source, /sandbox=""/);
    assert.match(source, /srcDoc=\{renderedPreview\.bodyHtml\}/);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  }
});

test("a normal template saves as a sanitized version and sends as a test log", async () => {
  const previous = await db.emailTemplate.findFirst({
    where: { category: "reminder", audience: "participant", projectId: null, isActive: true },
  });
  const created = await createTemplateVersion({
    category: "reminder", audience: "participant", projectId: null,
    subject: "Hello {{participant_name}}",
    bodyHtml: '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><p>Hi {{participant_name}}!</p></div>',
    actor: { id: "audit-template-actor", name: "Template Actor" },
  });
  let log;
  try {
    assert.equal(created.bodyHtml, '<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><p>Hi {{participant_name}}!</p></div>');
    log = await sendTestEmail(created.id, "template-test@example.test", { id: "audit-template-actor", name: "Template Actor" });
    assert.equal(log.status, "test");
    assert.equal(log.subject, "Hello Jane Doe");
    assert.equal(log.renderedBody, '<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><p>Hi Jane Doe!</p></div>');
    const templateAudit = await db.auditLog.findFirst({ where: { entityType: "EmailTemplate", entityId: created.id } });
    const sendAudit = await db.auditLog.findFirst({ where: { entityType: "NotificationLog", entityId: log.id } });
    for (const audit of [templateAudit, sendAudit]) {
      assert.equal(audit.actorId, "audit-template-actor");
      assert.equal(audit.actorLabel, "Template Actor");
      assert.notEqual(audit.actorLabel, "Unknown (auth not yet wired)");
      assert.notEqual(audit.actorLabel, "System");
    }
    console.log("RAW template save/send positive:", JSON.stringify({ savedBody: created.bodyHtml, loggedSubject: log.subject, loggedBody: log.renderedBody }));
  } finally {
    if (log) await db.notificationLog.delete({ where: { id: log.id } });
    await db.emailTemplate.delete({ where: { id: created.id } });
    if (previous) await db.emailTemplate.update({ where: { id: previous.id }, data: { isActive: true } });
    await db.auditLog.deleteMany({ where: { entityType: "EmailTemplate", entityId: created.id } });
  }
});
