#!/usr/bin/env node

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: id2ai <input.indd|input.idml> [output.ai]

Converts an InDesign file (.indd or .idml) to Illustrator (.ai).
Exports each InDesign layer of each page as a live-transparency PDF
(with bleed), then rebuilds the same layers and artboards in Illustrator.

Requires Adobe InDesign and Illustrator to be installed.
Works on macOS and Windows.

Options:
  --debug           Keep intermediate files
  --help, -h        Show this help
`);
  process.exit(0);
}

if (!IS_MAC && !IS_WIN) {
  console.error("Error: Only macOS and Windows are supported.");
  process.exit(1);
}

const inputFile = path.resolve(args[0]);
const debug = args.includes("--debug");

if (!fs.existsSync(inputFile)) {
  console.error(`Error: File not found: ${inputFile}`);
  process.exit(1);
}

const ext = path.extname(inputFile).toLowerCase();
if (ext !== ".indd" && ext !== ".idml") {
  console.error(`Error: Input must be an .indd or .idml file`);
  process.exit(1);
}

// Determine output path
let outputFile;
if (args[1] && !args[1].startsWith("--")) {
  outputFile = path.resolve(args[1]);
} else {
  outputFile = inputFile.replace(/\.(indd|idml)$/i, ".ai");
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "id2ai-"));
const manifestFile = path.join(tmpDir, "manifest.json");

console.log(`Converting: ${path.basename(inputFile)}`);
console.log(`Output:     ${path.basename(outputFile)}`);
console.log("");

// ---- STEP 1: Open in InDesign, export every layer of every page as its own PDF ----
console.log("[1/3] Opening in InDesign & exporting each layer per page as PDF...");

const indesignScript = `
var inputPath = "${jsEsc(inputFile)}";
var tmpDir = "${jsEsc(tmpDir)}";
var manifestPath = "${jsEsc(manifestFile)}";
var PRESET_NAME = "__id2ai_temp";

function q(s) { return '"' + String(s).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"'; }
function setp(o, k, v) { try { o[k] = v; } catch (e) {} }

app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
var doc = app.open(new File(inputPath));

doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;

// Original layer state (doc.layers[0] = top of stack)
var L = doc.layers;
var layerJson = [];
for (var j = 0; j < L.length; j++) {
  layerJson.push('{"name":' + q(L[j].name) + ',"visible":' + L[j].visible + ',"locked":' + L[j].locked + ',"printable":' + L[j].printable + '}');
}
for (var j = 0; j < L.length; j++) {
  setp(L[j], "printable", true);
  setp(L[j], "ignoreWrap", false);
}

// Pages + bleed per side
var dp = doc.documentPreferences;
var bTop = dp.documentBleedTopOffset, bBot = dp.documentBleedBottomOffset;
var bIn = dp.documentBleedInsideOrLeftOffset, bOut = dp.documentBleedOutsideOrRightOffset;
var pageJson = [];
for (var i = 0; i < doc.pages.length; i++) {
  var pg = doc.pages[i], b = pg.bounds;
  var bl = bIn, br = bOut;
  if (dp.facingPages && pg.side == PageSideOptions.LEFT_HAND) { bl = bOut; br = bIn; }
  pageJson.push('{"index":' + i + ',"name":' + q(pg.name) + ',"width":' + (b[3] - b[1]) + ',"height":' + (b[2] - b[0]) +
    ',"bleed":{"top":' + bTop + ',"bottom":' + bBot + ',"left":' + bl + ',"right":' + br + '}}');
}

var f = new File(manifestPath);
f.encoding = "UTF-8";
f.open("w");
f.write('{"pages":[' + pageJson.join(",") + '],"layers":[' + layerJson.join(",") + ']}');
f.close();

// Temporary PDF preset: live transparency, bleed, no marks, no downsampling, lossless images
var old = app.pdfExportPresets.itemByName(PRESET_NAME);
if (old.isValid) old.remove();
var P = app.pdfExportPresets.add({ name: PRESET_NAME });
setp(P, "acrobatCompatibility", AcrobatCompatibility.ACROBAT_7);
setp(P, "standardsCompliance", PDFXStandards.NONE);
setp(P, "useDocumentBleedWithPDF", true);
setp(P, "includeSlugWithPDF", false);
setp(P, "cropMarks", false);
setp(P, "bleedMarks", false);
setp(P, "registrationMarks", false);
setp(P, "colorBars", false);
setp(P, "pageInformationMarks", false);
setp(P, "exportReaderSpreads", false);
setp(P, "exportLayers", false);
setp(P, "generateThumbnails", false);
setp(P, "optimizePDF", false);
setp(P, "colorBitmapSampling", Sampling.NONE);
setp(P, "grayscaleBitmapSampling", Sampling.NONE);
setp(P, "monochromeBitmapSampling", Sampling.NONE);
setp(P, "colorBitmapCompression", BitmapCompression.ZIP);
setp(P, "grayscaleBitmapCompression", BitmapCompression.ZIP);
setp(P, "monochromeBitmapCompression", MonoBitmapCompression.ZIP);
setp(P, "subsetFontsBelow", 0);

// Page by page, layer by layer: show only that layer, export
for (var i = 0; i < doc.pages.length; i++) {
  app.pdfExportPreferences.pageRange = doc.pages[i].name;
  for (var j = 0; j < L.length; j++) {
    for (var k = 0; k < L.length; k++) setp(L[k], "visible", k == j);
    try {
      doc.exportFile(ExportFormat.PDF_TYPE, new File(tmpDir + "/p" + i + "_l" + j + ".pdf"), false, P);
    } catch (e) {}
  }
}

setp(app.pdfExportPreferences, "pageRange", PageRange.ALL_PAGES);
try { P.remove(); } catch (e) {}
doc.close(SaveOptions.NO);
`;

runInDesign(indesignScript);

if (!fs.existsSync(manifestFile)) {
  console.error("Error: InDesign failed - no manifest created.");
  cleanup();
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const bl = manifest.pages[0].bleed;
const toMm = (pt) => (pt * 25.4 / 72).toFixed(2);
console.log(`   Pages:  ${manifest.pages.length}`);
console.log(`   Layers: ${manifest.layers.map((l) => {
  const flags = [!l.visible && "hidden", l.locked && "locked", !l.printable && "non-printing"].filter(Boolean);
  return flags.length ? `${l.name} (${flags.join(", ")})` : l.name;
}).join(" / ")}`);
console.log(`   Bleed:  top ${toMm(bl.top)}mm, bottom ${toMm(bl.bottom)}mm, left ${toMm(bl.left)}mm, right ${toMm(bl.right)}mm`);
let exported = 0;
manifest.pages.forEach((p) => manifest.layers.forEach((l, j) => {
  if (fs.existsSync(path.join(tmpDir, `p${p.index}_l${j}.pdf`))) exported++;
}));
console.log(`   Exported ${exported} of ${manifest.pages.length * manifest.layers.length} page/layer PDFs`);
console.log("");

if (exported === 0) {
  console.error("Error: No PDFs were exported.");
  cleanup();
  process.exit(1);
}

// Gap between artboards: 50pt plus room for bleed on both sides
const maxBleed = Math.max(0, ...manifest.pages.map((p) => Math.max(p.bleed.left, p.bleed.right, p.bleed.top, p.bleed.bottom)));
const GAP = 50 + maxBleed * 2;

// ---- STEP 2: Rebuild in Illustrator with matching layers ----
console.log("[2/3] Building Illustrator document with matching layers...");

const buildScript = path.join(tmpDir, "ai_build.jsx");

const aiScript = `
app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

var M = ${JSON.stringify(manifest)};
var TMP = "${jsEsc(tmpDir)}";
var OUT = "${jsEsc(outputFile)}";
var COLS = 3, GAP = ${GAP};

// Log file so failures are visible instead of silent
var LOG = new File(TMP + "/ai_log.txt");
LOG.encoding = "UTF-8";
LOG.open("w");
function log(m) { LOG.writeln(m); }

// Place PDFs using their bleed box (trim + bleed)
var pdfOpts = app.preferences.PDFFileOptions;
var prevBox = null, prevPage = null;
try { prevBox = pdfOpts.pDFCropToBox; pdfOpts.pDFCropToBox = PDFBoxType.PDFBLEEDBOX; } catch (e) { log("WARN crop box: " + e); }
try { prevPage = pdfOpts.pageToOpen; pdfOpts.pageToOpen = 1; } catch (e) {}

var p0 = M.pages[0];
var doc = app.documents.add(DocumentColorSpace.CMYK, p0.width, p0.height);
var TMP_LAYER = "__id2ai_tmp";
doc.layers[0].name = TMP_LAYER;

// Layers: add bottom-first so the stack order matches InDesign
var aiLayers = [];
for (var j = M.layers.length - 1; j >= 0; j--) {
  var nl = doc.layers.add();
  nl.name = M.layers[j].name;
  aiLayers[j] = nl;
}

// Trim-size artboards in a 3-column grid
var base = doc.artboards[0].artboardRect;
var abPos = [];
for (var i = 0; i < M.pages.length; i++) {
  var pg = M.pages[i];
  var x = base[0] + (i % COLS) * (p0.width + GAP);
  var y = base[1] - Math.floor(i / COLS) * (p0.height + GAP);
  var r = [x, y, x + pg.width, y - pg.height];
  if (i == 0) doc.artboards[0].artboardRect = r; else doc.artboards.add(r);
  doc.artboards[i].name = "Page " + pg.name;
  abPos[i] = [x, y];
}

// Place each page/layer PDF straight into its layer, centre it on the trim
// (offset for uneven bleed), then embed so it becomes editable artwork.
// No clipboard, no opening extra documents.
var placedOk = 0, failed = 0;
for (var i = 0; i < M.pages.length; i++) {
  var pg = M.pages[i], bl = pg.bleed;
  var cx = abPos[i][0] + pg.width / 2 + (bl.right - bl.left) / 2;
  var cy = abPos[i][1] - pg.height / 2 + (bl.top - bl.bottom) / 2;
  for (var j = 0; j < M.layers.length; j++) {
    var f = new File(TMP + "/p" + i + "_l" + j + ".pdf");
    var tag = "Page " + pg.name + " / " + M.layers[j].name;
    if (!f.exists) { log("MISSING " + tag); failed++; continue; }
    try {
      var p = aiLayers[j].placedItems.add();
      p.file = f;
      p.left = cx - p.width / 2;
      p.top = cy + p.height / 2;
      p.embed();
      placedOk++;
      log("OK " + tag);
    } catch (e) {
      failed++;
      log("FAIL " + tag + ": " + e);
    }
  }
}

// Remove the temp layer and any empty stray layers
var keep = {};
for (var j = 0; j < aiLayers.length; j++) keep[aiLayers[j].name] = true;
for (var k = doc.layers.length - 1; k >= 0; k--) {
  var ly = doc.layers[k];
  if (doc.layers.length > 1 && (ly.name == TMP_LAYER || (!keep[ly.name] && ly.pageItems.length == 0))) {
    try { ly.remove(); } catch (e) { log("WARN remove layer " + ly.name + ": " + e); }
  }
}

// Restore original layer states
for (var j = 0; j < M.layers.length; j++) {
  var s = M.layers[j], al = aiLayers[j];
  try {
    if (!s.printable) al.printable = false;
    if (!s.visible) al.visible = false;
    if (s.locked) al.locked = true;
  } catch (e) { log("WARN layer state " + s.name + ": " + e); }
}
for (var a = doc.artboards.length - 1; a >= M.pages.length; a--) {
  try { doc.artboards.remove(a); } catch (e) {}
}
doc.artboards.setActiveArtboardIndex(0);

try { if (prevBox !== null) pdfOpts.pDFCropToBox = prevBox; } catch (e) {}
try { if (prevPage !== null) pdfOpts.pageToOpen = prevPage; } catch (e) {}

log("SUMMARY placed " + placedOk + ", failed " + failed);
LOG.close();

var saveOpts = new IllustratorSaveOptions();
saveOpts.compatibility = Compatibility.ILLUSTRATOR17;
saveOpts.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
saveOpts.pdfCompatible = true;
saveOpts.embedICCProfile = true;
doc.saveAs(new File(OUT), saveOpts);
`;

fs.writeFileSync(buildScript, aiScript, "utf8");

if (debug) {
  console.log(`   Build script: ${buildScript}`);
}

runIllustrator(buildScript);

const logFile = path.join(tmpDir, "ai_log.txt");
if (fs.existsSync(logFile)) {
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
  lines.filter((l) => !l.startsWith("OK ")).forEach((l) => console.log(`   ${l}`));
} else {
  console.log("   Warning: Illustrator didn't write a log - the build script may have stopped early.");
}

console.log("[3/3] Saved!");
console.log("");

if (!fs.existsSync(outputFile)) {
  console.error("Error: Output file not created.");
  cleanup();
  process.exit(1);
}

if (debug) {
  console.log(`   Debug files kept in: ${tmpDir}`);
} else {
  cleanup();
}

const inputSize = (fs.statSync(inputFile).size / 1024).toFixed(0);
const outputSize = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
console.log(`Done! ${inputSize}KB -> ${outputSize}MB`);
console.log(`Output: ${outputFile}`);
console.log("");
console.log(`Bleed: set File > Document Setup > Bleed to top ${toMm(bl.top)}mm, bottom ${toMm(bl.bottom)}mm, left ${toMm(bl.left)}mm, right ${toMm(bl.right)}mm`);

// ---- Helper Functions ----

function runInDesign(script) {
  const scriptFile = path.join(tmpDir, "indesign_script.jsx");
  fs.writeFileSync(scriptFile, script, "utf8");

  if (IS_MAC) {
    runInDesignMac(scriptFile);
  } else {
    runInDesignWin(scriptFile);
  }
}

function runInDesignMac(scriptFile) {
  const appNames = [
    "Adobe InDesign 2026",
    "Adobe InDesign 2025",
    "Adobe InDesign 2024",
  ];
  let lastErr;

  for (const appName of appNames) {
    try {
      execSync(
        `osascript -l JavaScript -e '
          var id = Application("${appName}");
          id.activate();
          id.doScript(Path("${scriptFile.replace(/"/g, '\\"')}"), {language: "javascript"});
        '`,
        { stdio: "pipe", timeout: 1800000 }
      );
      return;
    } catch (err) {
      const errMsg = err.stderr?.toString() || err.message || "";
      if (!errMsg.includes("can't be found") && !errMsg.includes("not found")) {
        console.error(`Error in InDesign script: ${errMsg}`);
        cleanup();
        process.exit(1);
      }
      lastErr = err;
    }
  }

  console.error("Error: Could not find Adobe InDesign (tried 2024-2026).");
  console.error(lastErr?.stderr?.toString() || lastErr?.message);
  cleanup();
  process.exit(1);
}

function runInDesignWin(scriptFile) {
  // InDesign COM ProgIDs to try
  const progIds = [
    "InDesign.Application.2026",
    "InDesign.Application.2025",
    "InDesign.Application.2024",
    "InDesign.Application",
  ];

  const vbsFile = path.join(tmpDir, "run_indesign.vbs");
  const jsxPath = scriptFile.replace(/\\/g, "\\\\");

  // Build VBScript that tries each ProgID
  let vbs = `On Error Resume Next\nDim app\nDim found\nfound = False\n`;
  for (const progId of progIds) {
    vbs += `
If Not found Then
  Set app = CreateObject("${progId}")
  If Not app Is Nothing Then
    If Err.Number = 0 Then
      found = True
    End If
  End If
  If Err.Number <> 0 Then
    Err.Clear
  End If
End If
`;
  }
  vbs += `
If Not found Then
  WScript.StdErr.WriteLine "Error: Could not find Adobe InDesign (tried 2024-2026)."
  WScript.Quit 1
End If

On Error GoTo 0
app.ScriptPreferences.UserInteractionLevel = 1699640946
app.DoScript "${jsxPath}", 1246973031
`;

  fs.writeFileSync(vbsFile, vbs, "utf8");

  try {
    execSync(`cscript //nologo "${vbsFile}"`, {
      stdio: "pipe",
      timeout: 1800000,
    });
  } catch (err) {
    console.error(`Error in InDesign script: ${err.stderr?.toString() || err.message}`);
    cleanup();
    process.exit(1);
  }
}

function runIllustrator(scriptPath) {
  if (IS_MAC) {
    runIllustratorMac(scriptPath);
  } else {
    runIllustratorWin(scriptPath);
  }
}

function runIllustratorMac(scriptPath) {
  const appNames = [
    "Adobe Illustrator",
    "Adobe Illustrator 2026",
    "Adobe Illustrator 2025",
    "Adobe Illustrator 2024",
  ];
  let lastErr;

  for (const appName of appNames) {
    try {
      execSync(
        `osascript -l JavaScript -e '
          var ai = Application("${appName}");
          ai.activate();
          ai.doJavascript("$.evalFile(\\x27${jsEsc(scriptPath)}\\x27);");
        '`,
        { stdio: "pipe", timeout: 1800000 }
      );
      return;
    } catch (err) {
      const errMsg = err.stderr?.toString() || err.message || "";
      if (!errMsg.includes("can't be found") && !errMsg.includes("not found")) {
        console.error(`Error in Illustrator script: ${errMsg}`);
        cleanup();
        process.exit(1);
      }
      lastErr = err;
    }
  }

  console.error("Error: Could not find Adobe Illustrator (tried 2024-2026).");
  console.error(lastErr?.stderr?.toString() || lastErr?.message);
  cleanup();
  process.exit(1);
}

function runIllustratorWin(scriptPath) {
  const progIds = [
    "Illustrator.Application.2026",
    "Illustrator.Application.2025",
    "Illustrator.Application.2024",
    "Illustrator.Application",
  ];

  const vbsFile = path.join(tmpDir, "run_illustrator.vbs");
  const jsxPath = jsEsc(scriptPath).replace(/'/g, "''");

  let vbs = `On Error Resume Next\nDim app\nDim found\nfound = False\n`;
  for (const progId of progIds) {
    vbs += `
If Not found Then
  Set app = CreateObject("${progId}")
  If Not app Is Nothing Then
    If Err.Number = 0 Then
      found = True
    End If
  End If
  If Err.Number <> 0 Then
    Err.Clear
  End If
End If
`;
  }
  vbs += `
If Not found Then
  WScript.StdErr.WriteLine "Error: Could not find Adobe Illustrator (tried 2024-2026)."
  WScript.Quit 1
End If

On Error GoTo 0
app.DoJavaScript "$.evalFile('${jsxPath}');"
`;

  fs.writeFileSync(vbsFile, vbs, "utf8");

  try {
    execSync(`cscript //nologo "${vbsFile}"`, {
      stdio: "pipe",
      timeout: 1800000,
    });
  } catch (err) {
    console.error(`Error in Illustrator script: ${err.stderr?.toString() || err.message}`);
    cleanup();
    process.exit(1);
  }
}

function jsEsc(str) {
  return str.replace(/\\/g, "/").replace(/"/g, '\\"');
}

function cleanup() {
  if (!debug) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}
