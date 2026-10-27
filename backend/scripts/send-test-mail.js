#!/usr/bin/env node
/**
 * Envoie un e-mail de test avec les réglages SMTP du .env (L57).
 *
 *   node backend/scripts/send-test-mail.js ton@adresse.fr
 *
 * Lit backend/.env (sinon le .env du dossier courant). Affiche la réponse du
 * serveur SMTP, ou l'erreur exacte si l'envoi échoue.
 */

const path = require('path');
const fs = require('fs');

const envFile = path.join(__dirname, '..', '.env');
require('dotenv').config(fs.existsSync(envFile) ? { path: envFile } : undefined);

const { mailEnabled, sendMail } = require('../mailer');

(async () => {
  const to = process.argv[2];
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error('Usage : node backend/scripts/send-test-mail.js ton@adresse.fr');
    process.exit(1);
  }
  if (!mailEnabled()) {
    console.error('❌ SMTP_HOST, SMTP_USER ou SMTP_PASS manquant dans le .env');
    process.exit(1);
  }
  console.log(`📨 Envoi via ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} (${process.env.SMTP_USER})`);
  console.log(`   de   : ${process.env.MAIL_FROM || 'Versant <noreply@versant-app.fr>'}`);
  console.log(`   à    : ${to}`);
  try {
    const info = await sendMail({
      to,
      subject: 'Versant : e-mail de test',
      title: 'Ça marche ! 🎉',
      lines: [
        'Cet e-mail de test confirme que Versant peut envoyer des messages depuis noreply@versant-app.fr.',
        `Envoyé le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}.`
      ],
      code: '123456',
      footer: 'Le code ci-dessus est un exemple : c\'est ainsi que s\'afficheront les codes de validation.'
    });
    console.log(`✅ Accepté par le serveur SMTP : ${info.response}`);
    console.log(`   messageId : ${info.messageId}`);
    console.log('   Vérifie ta boîte de réception (et les spams).');
  } catch (error) {
    console.error(`❌ Échec : ${error.message}`);
    if (error.responseCode === 535) console.error('   Identifiant ou clé SMTP refusés : vérifie SMTP_USER et SMTP_PASS.');
    process.exit(1);
  }
})();
