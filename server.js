const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const multer = require('multer');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.query.path || os.homedir()),
  filename: (req, file, cb) => cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage });

// ── Drives (χωρίς wmic) ──────────────────────────────────────────────────────
function getDrives() {
  if (process.platform !== 'win32') return ['/'];
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\';
    try { fs.accessSync(d); drives.push(d); } catch(e) {}
  }
  return drives;
}

// ── Λίστα αρχείων ────────────────────────────────────────────────────────────
app.get('/api/list', (req, res) => {
  let dirPath = req.query.path || os.homedir();
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = items.map(item => {
      let size = 0, modified = '', created = '';
      try {
        const stat = fs.statSync(path.join(dirPath, item.name));
        size = stat.size;
        modified = stat.mtime.toISOString();
        created = stat.birthtime.toISOString();
      } catch(e) {}
      return {
        name: item.name,
        isDir: item.isDirectory(),
        size, modified, created,
        ext: item.isDirectory() ? '' : path.extname(item.name).toLowerCase()
      };
    });
    result.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, 'el');
    });
    res.json({ path: dirPath, items: result, drives: getDrives(), parent: path.dirname(dirPath) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ιδιότητες αρχείου ────────────────────────────────────────────────────────
app.get('/api/props', (req, res) => {
  const filePath = req.query.path;
  try {
    const stat = fs.statSync(filePath);
    res.json({
      name: path.basename(filePath),
      fullPath: filePath,
      size: stat.size,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      isDir: stat.isDirectory(),
      ext: path.extname(filePath).toLowerCase(),
      readonly: false
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Μετονομασία ──────────────────────────────────────────────────────────────
app.post('/api/rename', (req, res) => {
  const { dir, oldName, newName } = req.body;
  try {
    fs.renameSync(path.join(dir, oldName), path.join(dir, newName));
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Διαγραφή ─────────────────────────────────────────────────────────────────
app.post('/api/delete', (req, res) => {
  const { dir, name } = req.body;
  try {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else fs.unlinkSync(full);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Νέος φάκελος ─────────────────────────────────────────────────────────────
app.post('/api/mkdir', (req, res) => {
  const { dir, name } = req.body;
  try {
    fs.mkdirSync(path.join(dir, name));
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Αντιγραφή ────────────────────────────────────────────────────────────────
app.post('/api/copy', (req, res) => {
  const { srcDir, name, destDir } = req.body;
  const src = path.join(srcDir, name);
  let dest = path.join(destDir, name);

  // Αν υπάρχει ήδη, προσθέτουμε "_copy"
  if (fs.existsSync(dest)) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    dest = path.join(destDir, base + '_copy' + ext);
  }

  try {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) copyDirRecursive(src, dest);
    else fs.copyFileSync(src, dest);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── Μετακίνηση (drag & drop μεταξύ panels) ───────────────────────────────────
app.post('/api/move', (req, res) => {
  const { srcDir, name, destDir } = req.body;
  const src = path.join(srcDir, name);
  let dest = path.join(destDir, name);

  if (fs.existsSync(dest)) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    dest = path.join(destDir, base + '_moved' + ext);
  }

  try {
    fs.renameSync(src, dest);
    res.json({ ok: true });
  } catch(err) {
    // Αν είναι cross-drive, κάνουμε copy+delete
    try {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) copyDirRecursive(src, dest);
      else fs.copyFileSync(src, dest);
      if (stat.isDirectory()) fs.rmSync(src, { recursive: true, force: true });
      else fs.unlinkSync(src);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
});

// ── Upload ───────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.array('files'), (req, res) => {
  res.json({ ok: true, count: req.files.length });
});

// ── Image preview ─────────────────────────────────────────────────────────────
app.get('/api/image', (req, res) => {
  try { res.sendFile(req.query.path); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const { dir, query } = req.query;
  const results = [];
  function searchDir(d, depth = 0) {
    if (depth > 4) return;
    try {
      const items = fs.readdirSync(d, { withFileTypes: true });
      for (const item of items) {
        if (item.name.toLowerCase().includes(query.toLowerCase())) {
          results.push({ name: item.name, path: d, isDir: item.isDirectory() });
        }
        if (item.isDirectory() && depth < 4) {
          try { searchDir(path.join(d, item.name), depth + 1); } catch(e) {}
        }
      }
    } catch(e) {}
  }
  searchDir(dir);
  res.json({ results: results.slice(0, 200) });
});

app.listen(PORT, () => {
  console.log(`\n✅ Web Explorer v2 τρέχει στο: http://localhost:${PORT}\n`);
  console.log(`   Πάτα Ctrl+C για να σταματήσει\n`);
});
