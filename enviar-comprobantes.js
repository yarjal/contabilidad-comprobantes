// Se ejecuta una vez al día (ver .github/workflows/enviar-comprobantes.yml).
// 1) Pide a Firestore los comprobantes de "hoy" (hora Ecuador).
// 2) Arma un .zip con las fotos + un resumen en texto.
// 3) Lo manda por correo con nodemailer.

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const nodemailer = require('nodemailer');

const PROJECT_ID = 'luiguies-2f628'; // mismo proyecto de Firebase de siempre

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const DEST_EMAIL = process.env.DEST_EMAIL;

function hoyEcuador() {
  // America/Guayaquil = UTC-5 todo el año (sin horario de verano)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date()); // ya viene como YYYY-MM-DD
}

function money(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}

async function obtenerComprobantesDeHoy(fecha) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'receipts' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'date' },
          op: 'EQUAL',
          value: { stringValue: fecha }
        }
      }
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Firestore respondió ${res.status}: ${await res.text()}`);
  }
  const rows = await res.json();
  const recibos = [];
  for (const row of rows) {
    if (!row.document) continue;
    const f = row.document.fields || {};
    recibos.push({
      time: f.time?.stringValue || '',
      amount: f.amount?.doubleValue ?? Number(f.amount?.integerValue || 0),
      photoBase64: f.photoBase64?.stringValue || '',
      needsReview: f.needsReview?.booleanValue || false
    });
  }
  return recibos;
}

async function main() {
  const fecha = hoyEcuador();
  console.log('Buscando comprobantes de', fecha);
  const recibos = await obtenerComprobantesDeHoy(fecha);
  console.log('Encontrados:', recibos.length);

  const tmpDir = path.join(__dirname, 'tmp-comprobantes');
  fs.mkdirSync(tmpDir, { recursive: true });

  let total = 0;
  let resumen = `Comprobantes del ${fecha}\n\n`;
  recibos.forEach((r, i) => {
    total += Number(r.amount) || 0;
    const nombreFoto = `comprobante-${String(i + 1).padStart(3, '0')}.jpg`;
    if (r.photoBase64) {
      fs.writeFileSync(path.join(tmpDir, nombreFoto), Buffer.from(r.photoBase64, 'base64'));
    }
    resumen += `${nombreFoto} · ${r.time} · ${money(r.amount)}${r.needsReview ? '  (marcado para revisar)' : ''}\n`;
  });
  resumen += `\nTotal del día: ${money(total)}\n`;
  resumen += `Cantidad de comprobantes: ${recibos.length}\n`;
  fs.writeFileSync(path.join(tmpDir, 'resumen.txt'), resumen);

  const zipPath = path.join(__dirname, `comprobantes-${fecha}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(tmpDir, false);
    archive.finalize();
  });
  console.log('Zip creado:', zipPath);

  if (recibos.length === 0) {
    console.log('No hay comprobantes hoy, no se envía correo.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });

  await transporter.sendMail({
    from: GMAIL_USER,
    to: DEST_EMAIL,
    subject: `Comprobantes del ${fecha} — Total ${money(total)}`,
    text: resumen,
    attachments: [{ filename: `comprobantes-${fecha}.zip`, path: zipPath }]
  });

  console.log('Correo enviado a', DEST_EMAIL);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
