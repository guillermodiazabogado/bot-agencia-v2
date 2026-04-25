require('dotenv').config();


const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');


const SCOPES = ['https://www.googleapis.com/auth/calendar'];


const creds = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
const root = creds.installed || creds.web;


const oAuth2Client = new google.auth.OAuth2(
  root.client_id,
  root.client_secret,
  root.redirect_uris[0]
);


const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});


console.log('\nAbrí este link en el navegador:\n');
console.log(authUrl);


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});


rl.question('\nPegá acá el código que te da Google: ', async (code) => {
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    oAuth2Client.setCredentials(tokens);


    fs.writeFileSync('token.json', JSON.stringify(tokens, null, 2));
    console.log('\n✅ token.json creado correctamente');
  } catch (err) {
    console.error('\n❌ Error generando token:', err.message);
  } finally {
    rl.close();
  }
});


