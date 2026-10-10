import fs from "node:fs";
import path from "node:path";

export function pdfRunOutcome({ envelope, noOutputMessage, sawError, cleanExit, hasPaths }) {
  if (noOutputMessage) return { ok: false, message: noOutputMessage };
  if (envelope?.ok !== true || !cleanExit || sawError || !hasPaths) {
    const why = envelope && envelope.ok === false ? ` (${envelope.error})` : "";
    return {
      ok: false,
      message: `This run didn't produce a tailored CV to render, so no PDF was generated — re-run it to verify.${why}`,
    };
  }
  return { ok: true };
}

export function writeCvHtml({ pdfPaths, html }) {
  try {
    fs.writeFileSync(pdfPaths.html, html, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Could not save the tailored CV to ${err.path ?? pdfPaths.html}: ${err.message}` };
  }
}

export function spawnGeneratePdf({ spawnFn, execPath, root, html, finalPdf, format, reportNum }) {
  return new Promise((resolve) => {
    const child = spawnFn(
      execPath,
      [path.join(root, "generate-pdf.mjs"), html, finalPdf, `--format=${format}`, `--report=${reportNum}`, "--allow-reorder"],
      { cwd: root },
    );
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ ok: false, stderr: `PDF rendering failed to start: ${e.message}` }));
  });
}

export function markTrackerReady({ spawnFn, execPath, root, reportNum }) {
  return new Promise((resolve) => {
    const child = spawnFn(execPath, [path.join(root, "mark-pdf-ready.mjs"), reportNum, "--json"], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      let data = null;
      try { data = JSON.parse(stdout); } catch { }
      resolve({ ok: code === 0, data, stderr: stderr.trim() });
    });
    child.on("error", (e) => resolve({ ok: false, data: null, stderr: `mark-pdf-ready.mjs failed to start: ${e.message}` }));
  });
}

export function cleanupPdfScratch(scratchDir, prefix) {
  let entries;
  try {
    entries = fs.readdirSync(scratchDir);
  } catch (err) {
    console.error(`pdf scratch cleanup: could not list ${scratchDir}: ${err.message}`);
    return;
  }
  for (const f of entries) {
    if (!f.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(scratchDir, f), { force: true });
    } catch (err) {
      console.error(`pdf scratch cleanup: could not remove ${f}: ${err.message}`);
    }
  }
}

export async function renderAndMarkPdf({ spawnFn, execPath, root, pdfPaths, format, reportNum }) {
  const warnings = [];

  const render = await spawnGeneratePdf({ spawnFn, execPath, root, html: pdfPaths.html, finalPdf: pdfPaths.finalPdf, format, reportNum });
  cleanupPdfScratch(path.dirname(pdfPaths.html), `cv-web-${reportNum}.`);

  if (!render.ok) {
    return { kind: "render-failed", error: render.stderr || "PDF rendering failed." };
  }

  for (const line of render.stderr.split("\n")) {
    const text = line.trim();
    if (text) warnings.push(text);
  }

  const mark = await markTrackerReady({ spawnFn, execPath, root, reportNum });
  if (!mark.ok) {
    console.error(`mark-pdf-ready.mjs failed for report #${reportNum}: ${mark.data?.error ?? mark.stderr}`);
    warnings.push(
      mark.data?.error
        ? `PDF rendered, but the tracker wasn't updated: ${mark.data.error}`
        : `PDF rendered, but the tracker's PDF column wasn't updated automatically — run \`node mark-pdf-ready.mjs ${reportNum}\` manually.`,
    );
  }

  return { kind: "rendered", warnings };
}
