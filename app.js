'use strict';

/* =========================================================
   Kouakou~Renfo – séances et encaissements
   Aucune dépendance. Deux modes de stockage :
   - local : données gardées dans ce navigateur (essai, un seul poste)
   - en ligne : données dans un Google Sheet via le service Apps Script (Code.gs)
   ========================================================= */

/* ---------- Constantes ---------- */
const NIVEAUX = ['L1', 'L2', 'L3'];
const VUES = ['seance', 'fiche', 'base', 'caisse'];
const ATTENTE = 'waiting next day';
const PRESENCES = [
  { v: 'OUI', label: 'Présent', cls: 'oui' },
  { v: 'NON', label: 'Absent', cls: 'non' },
  { v: 'Bonus*', label: 'Bonus', cls: 'bonus' },
  { v: ATTENTE, label: 'En attente', cls: 'attente' },
];
const MODES = [
  { v: 'ESPECES', label: 'Espèces' },
  { v: 'WAVE', label: 'Wave' },
  { v: 'AUTRE', label: 'Autre application' },
  { v: 'SEANCE', label: 'Séance en avance' },
];
const LIB_MODE = Object.fromEntries(MODES.map(m => [m.v, m.label]));
const LIB_TYPE = { ENCAISSEMENT: 'Séance', REGLEMENT: 'Règlement du solde', ANNULATION: 'Annulation' };
const OPERATEURS = ['Orange Money', 'MTN MoMo', 'Moov Money'];
const CHAMPS = [
  ['id', "N° d'ordre"], ['nom', 'Nom et prénoms'], ['contact', 'Contact'], ['email', 'E-mail'],
  ['filiere', 'Filière'], ['statut', "Statut d'inscription"], ['avance', 'Séances en avance'],
  ['arriere', 'Séances non réglées'], ['creance', 'Créance'], ['redevance', 'Redevance'],
  ['presence', 'Présence'], ['tampon', 'Tampon'], ['solde', 'Solde'],
];
const NOMBRES = new Set(['id', 'avance', 'arriere', 'creance', 'redevance', 'tampon', 'solde']);
// En-têtes de l'ancien classeur Excel reconnus à l'import (après normalisation)
const ALIAS_ENTETES = {
  'nom et prenom': 'nom', 'n d ordre': 'id', 'e mail': 'email', 'filere': 'filiere',
  'statut inscrption': 'statut', 'statut inscription': 'statut',
  'presence anterieur': 'presence', 'presence anterieure': 'presence',
};
const CLE_DONNEES = 'renfo:v2';
const CLE_URL = 'renfo:url';
const CLE_CODE = 'renfo:code';
const CLE_NIVEAU = 'renfo:niveau';

/* ---------- État ---------- */
const state = {
  niveau: 'L1', vue: 'seance',
  data: { L1: [], L2: [], L3: [] },
  paiements: [], aujourdhui: '',
  settings: { tarif: 500 },
  role: 'admin', utilisateur: 'Local',
  conn: { url: '', code: '' },
  charge: false, hors_ligne: false, erreur: '', rev: 0,
  choix: {}, filtre: '',
  caisseDate: '', caisseTous: false, caisseJours: {},
};

/* ---------- Outils ---------- */
const $ = (s, r = document) => r.querySelector(s);

// Création d'éléments DOM. Les données ne passent jamais par innerHTML.
function h(tag, attrs, ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const e of enfants.flat()) {
    if (e === null || e === undefined || e === false) continue;
    el.append(e.nodeType ? e : document.createTextNode(String(e)));
  }
  return el;
}

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fcfa = n => new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
const dateFr = () => new Date().toLocaleDateString('fr-FR',
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const aujourdhui = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Jour de référence : celui du service en ligne (heure d'Abidjan), sinon celui de l'appareil
const jour = () => (state.conn.url && state.aujourdhui) || aujourdhui();
const heure = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
const nouvelleRef = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const entier = v => Math.max(0, Math.round(Number(v)) || 0);

let minuteurToast;
function toast(msg, erreur) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'visible' + (erreur ? ' err' : '');
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => { t.className = ''; }, 4500);
}

/* ---------- Règles métier ---------- */
// nombre de séance : Présent = tampon + 1 ; Absent ou Bonus = 0 ; en attente = tampon inchangé
const seances = s => s.presence === 'OUI' ? s.tampon + 1
  : (s.presence === 'NON' || s.presence === 'Bonus*') ? 0 : s.tampon;

const liste = () => state.data[state.niveau];
const nouvelEleve = id => ({
  id, nom: '', contact: '', email: '', filiere: '', statut: 'OUI',
  avance: 0, arriere: 0, creance: 0, redevance: 0, presence: ATTENTE, tampon: 0, solde: 0,
});
const prochainId = l => l.reduce((m, s) => Math.max(m, s.id), 0) + 1;
const filtrer = l => {
  const f = norm(state.filtre);
  return f ? l.filter(s => norm(s.nom).includes(f) || String(s.id) === f) : l;
};

// Solde de l'élève : positif = on lui doit de l'argent (monnaie à rendre), négatif = il nous doit.
const soldeTexte = s => s.solde > 0 ? `On lui doit ${fcfa(s.solde)}` : s.solde < 0 ? `Il doit ${fcfa(-s.solde)}` : 'Aucun';

// Calcul d'un encaissement (même règle dans Code.gs). Lève une erreur si la saisie est incohérente.
function calculerEncaissement({ mode, recu, rendu, precision }, tarif, avance) {
  if (!LIB_MODE[mode]) throw new Error('Mode de paiement inconnu.');
  if (mode === 'SEANCE') {
    if (avance < 1) throw new Error("Cet élève n'a aucune séance en avance.");
    return { du: tarif, recu: 0, rendu: 0, net: 0, effetSolde: 0, effetAvance: -1, precision: '' };
  }
  recu = entier(recu); rendu = entier(rendu);
  precision = String(precision || '').trim().slice(0, 80);
  if (mode === 'AUTRE' && !precision) throw new Error("Précisez l'application utilisée.");
  if (rendu > Math.max(0, recu - tarif)) throw new Error('La monnaie rendue dépasse la monnaie due.');
  return { du: tarif, recu, rendu, net: recu - rendu, effetSolde: recu - rendu - tarif, effetAvance: 0,
    precision: mode === 'ESPECES' ? '' : precision };
}

// Règlement (partiel ou total) d'un solde : on rend la monnaie due, ou l'élève paie sa dette.
function calculerReglement({ montant, mode, precision }, solde) {
  if (!LIB_MODE[mode] || mode === 'SEANCE') throw new Error('Mode de paiement invalide.');
  if (!solde) throw new Error("Cet élève n'a aucun solde à régler.");
  const m = entier(montant);
  if (m < 1 || m > Math.abs(solde)) throw new Error(`Le montant doit être compris entre 1 et ${Math.abs(solde)} FCFA.`);
  precision = String(precision || '').trim().slice(0, 80);
  if (mode === 'AUTRE' && !precision) throw new Error("Précisez l'application utilisée.");
  const sens = solde > 0 ? -1 : 1;
  return { recu: m, net: sens * m, effetSolde: sens * m, precision: mode === 'ESPECES' ? '' : precision };
}

const encaissementDuJour = (niveau, id) => state.paiements.find(x =>
  x.date === jour() && x.niveau === niveau && x.eleve === id && x.type === 'ENCAISSEMENT' && !x.annulePar);

// Applique une modification à l'état local (le service fait la même chose côté Google Sheet)
function appliquer(action, p) {
  const l = state.data[p.niveau];
  switch (action) {
    case 'setPresence': { const s = l.find(x => x.id === p.id); if (s) s.presence = p.presence; break; }
    case 'updateStudent': { const s = l.find(x => x.id === p.id); if (s) Object.assign(s, p.patch); break; }
    case 'addStudent': l.push(p.student); break;
    case 'deleteStudent': state.data[p.niveau] = l.filter(x => x.id !== p.id); break;
    case 'actualiser': l.forEach(s => { s.tampon = seances(s); s.presence = ATTENTE; }); break;
    case 'replaceStudents': state.data[p.niveau] = p.students; break;
    case 'setSettings': Object.assign(state.settings, p.settings); break;
  }
}

async function commit(action, p, { silencieux = false } = {}) {
  state.rev++;
  appliquer(action, p);
  if (!silencieux) render();
  if (!state.conn.url) { sauverLocal(); return; }
  try {
    await appeler(action, p);
    if (['actualiser', 'replaceStudents', 'addStudent'].includes(action)) await recharger(true);
  } catch (e) {
    toast(e.message, true);
    await recharger(true);
  }
}

// Encaissements, règlements et annulations : en ligne, c'est le service qui décide (pas d'affichage anticipé).
function appliquerCaisse(action, p) {
  if (state.paiements.some(x => x.ref === p.ref)) return;   // déjà enregistré (double envoi)
  const base = { ref: p.ref, horodatage: new Date().toISOString(), date: aujourdhui(), niveau: p.niveau,
    utilisateur: state.utilisateur, annulePar: '', annulationDe: '' };
  const trouver = (niveau, id) => {
    const s = state.data[niveau].find(x => x.id === id);
    if (!s) throw new Error('Élève introuvable.');
    return s;
  };
  if (action === 'encaisser') {
    const s = trouver(p.niveau, p.id);
    if (encaissementDuJour(p.niveau, s.id)) {
      throw new Error("Un encaissement est déjà enregistré aujourd'hui pour cet élève. Un administrateur peut l'annuler dans la Caisse.");
    }
    const r = calculerEncaissement(p, state.settings.tarif, s.avance);
    s.solde += r.effetSolde; s.avance += r.effetAvance;
    state.paiements.push({ ...base, eleve: s.id, nom: s.nom, type: 'ENCAISSEMENT', mode: p.mode, ...r });
  } else if (action === 'regler') {
    const s = trouver(p.niveau, p.id);
    const r = calculerReglement(p, s.solde);
    s.solde += r.effetSolde;
    state.paiements.push({ ...base, eleve: s.id, nom: s.nom, type: 'REGLEMENT', mode: p.mode,
      du: 0, recu: r.recu, rendu: 0, net: r.net, effetSolde: r.effetSolde, effetAvance: 0, precision: r.precision });
  } else if (action === 'annuler') {
    if (state.role !== 'admin') throw new Error('Action réservée aux administrateurs.');
    const o = state.paiements.find(x => x.ref === p.cible);
    if (!o || o.annulePar || o.type === 'ANNULATION') throw new Error('Opération introuvable ou déjà annulée.');
    const s = trouver(o.niveau, o.eleve);
    s.solde -= o.effetSolde; s.avance -= o.effetAvance;
    o.annulePar = p.ref;
    state.paiements.push({ ...base, niveau: o.niveau, eleve: o.eleve, nom: o.nom, type: 'ANNULATION', mode: o.mode,
      precision: o.precision, du: 0, recu: 0, rendu: 0, net: -o.net, effetSolde: -o.effetSolde,
      effetAvance: -o.effetAvance, annulationDe: o.ref });
  }
}

async function operationCaisse(action, p) {
  if (!state.conn.url) { appliquerCaisse(action, p); sauverLocal(); render(); return; }
  await appeler(action, p);
  await recharger(true);
}

/* ---------- Stockage local ---------- */
function chargerLocal() {
  try {
    const brut = JSON.parse(localStorage.getItem(CLE_DONNEES));
    if (brut && brut.data) {
      state.data = brut.data; state.settings = brut.settings || state.settings; state.paiements = brut.paiements || [];
    }
  } catch (_) { /* première utilisation */ }
  for (const n of NIVEAUX) state.data[n] = (state.data[n] || []).map(s => ({ solde: 0, ...s }));
  state.role = 'admin'; state.utilisateur = 'Local'; state.charge = true;
}
function sauverLocal() {
  try {
    localStorage.setItem(CLE_DONNEES, JSON.stringify({ data: state.data, settings: state.settings, paiements: state.paiements }));
  } catch (_) { toast('Enregistrement impossible dans ce navigateur (stockage bloqué ou plein).', true); }
}
function lireConn() {
  try {
    return { url: localStorage.getItem(CLE_URL) || '',
      code: sessionStorage.getItem(CLE_CODE) || localStorage.getItem(CLE_CODE) || '' };
  } catch (_) { return { url: '', code: '' }; }
}
function oublierCode() {
  try { sessionStorage.removeItem(CLE_CODE); localStorage.removeItem(CLE_CODE); } catch (_) { /* rien */ }
  state.conn.code = ''; state.charge = false; state.erreur = '';
  state.data = { L1: [], L2: [], L3: [] }; state.paiements = []; state.caisseJours = {};
}

/* ---------- Service en ligne (Google Apps Script) ---------- */
async function appeler(action, p = {}) {
  let rep;
  try {
    rep = await fetch(state.conn.url, {
      method: 'POST', redirect: 'follow',
      body: JSON.stringify({ ...p, action, code: state.conn.code }),
    });
  } catch (_) { throw new Error('Connexion impossible. Vérifiez votre accès internet.'); }
  let j;
  try { j = await rep.json(); }
  catch (_) { throw new Error("Réponse inattendue du service. Vérifiez l'adresse et le déploiement (accès « Tout le monde »)."); }
  if (!j.ok) throw new Error(j.error || 'Erreur du service.');
  return j;
}

const enSaisie = () => {
  const a = document.activeElement;
  return a && $('#app').contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.dataset.k !== 'filtre';
};

async function recharger(silencieux) {
  if (!state.conn.url || !state.conn.code) return false;
  const rev0 = state.rev;
  try {
    const j = await appeler('load');
    if (silencieux && state.rev !== rev0) return true;   // une modification est partie entre-temps
    Object.assign(state, { role: j.role, utilisateur: j.nom, aujourdhui: j.aujourdhui, data: j.data,
      paiements: j.paiements || [], settings: { tarif: Number(j.settings.tarif) || 500 },
      charge: true, hors_ligne: false, erreur: '' });
    if (silencieux && enSaisie()) majEtat(); else render();
    return true;
  } catch (e) {
    if (/invalide/i.test(e.message)) { oublierCode(); toast(e.message, true); render(); return false; }
    state.hors_ligne = true; state.erreur = e.message;
    if (!silencieux) toast(e.message, true);
    if (state.charge) majEtat(); else render();
    return false;
  }
}

/* ---------- Composants ---------- */
function chips(s) {
  return h('div', { class: 'chips', role: 'group', 'aria-label': `Présence de ${s.nom || "l'élève"}` },
    PRESENCES.map(p => h('button', {
      type: 'button', class: `chip ${p.cls}`, 'aria-pressed': String(s.presence === p.v),
      'data-k': `${s.id}-${p.cls}`,
      onclick: () => { if (s.presence !== p.v) commit('setPresence', { niveau: state.niveau, id: s.id, presence: p.v }); },
    }, p.label)));
}

const recherche = () => h('input', {
  type: 'search', class: 'recherche', placeholder: 'Rechercher un nom', 'aria-label': 'Rechercher un élève',
  value: state.filtre, 'data-k': 'filtre',
  oninput: e => { state.filtre = e.target.value; render(); },
});

function vide() {
  const admin = state.role === 'admin';
  return h('div', { class: 'vide' },
    h('p', null, `Aucun élève en ${state.niveau} pour le moment.`),
    admin
      ? h('a', { href: `#/${state.niveau}/base` }, 'Ajouter des élèves ou importer un fichier CSV')
      : h('p', null, "Un administrateur doit d'abord ajouter les élèves."));
}

const libPaiement = p => LIB_MODE[p.mode] + (p.mode === 'AUTRE' && p.precision ? ` (${p.precision})` : '');

// Bouton « Encaisser », ou rappel du paiement déjà enregistré aujourd'hui
function paiementCellule(s) {
  const p = encaissementDuJour(state.niveau, s.id);
  if (p) {
    return h('span', { class: 'paye', title: `Enregistré à ${heure(p.horodatage)} par ${p.utilisateur}` },
      h('b', null, 'Payé'), h('small', null, libPaiement(p)));
  }
  return h('button', { type: 'button', class: 'primaire encaisser', 'data-k': `${s.id}-pay`,
    onclick: () => ouvrirEncaisser(s, state.niveau) }, 'Encaisser');
}

const boutonSolde = (s, niveau) => s.solde !== 0 && h('button', {
  type: 'button', class: `solde ${s.solde > 0 ? 'du' : 'dette'}`, onclick: () => ouvrirRegler(s, niveau),
  title: s.solde > 0 ? 'Rendre la monnaie due' : "Encaisser ce que l'élève doit",
}, soldeTexte(s));

/* ---------- Fenêtres : encaisser / régler ---------- */
function champForm(libelle, ...contenu) { return h('label', { class: 'cf' }, h('span', null, libelle), ...contenu); }

function ouvrirEncaisser(s, niveau) {
  const dlg = $('#dlg');
  const tarif = state.settings.tarif;
  const ref = nouvelleRef();                       // même référence si l'envoi est répété : pas de doublon
  let mode = 'ESPECES';
  const recu = h('input', { type: 'number', min: 0, step: 50, inputmode: 'numeric', value: tarif });
  const rendu = h('input', { type: 'number', min: 0, step: 50, inputmode: 'numeric', value: 0 });
  const prec = h('input', { type: 'text', maxlength: 80, list: 'operateurs', autocomplete: 'off' });
  const libPrec = h('span');
  const lRecu = champForm('Montant remis par l\'élève (FCFA)', recu);
  const lRendu = champForm('Monnaie rendue maintenant (FCFA)', rendu);
  const lPrec = h('label', { class: 'cf' }, libPrec, prec);
  const resume = h('p', { class: 'resume', 'aria-live': 'polite' });
  const erreur = h('p', { class: 'erreur', role: 'alert' });
  const valider = h('button', { type: 'submit', class: 'primaire' }, "Enregistrer l'encaissement");
  const boutons = MODES.map(m => h('button', {
    type: 'button', class: 'chip mode', 'aria-pressed': 'false', onclick: () => { mode = m.v; maj(); },
  }, m.v === 'SEANCE' ? `${m.label} (${s.avance})` : m.label));

  function maj() {
    boutons.forEach((b, i) => b.setAttribute('aria-pressed', String(MODES[i].v === mode)));
    const seance = mode === 'SEANCE';
    const r = entier(recu.value);
    lRecu.hidden = seance;
    lRendu.hidden = seance || r <= tarif;
    lPrec.hidden = !(mode === 'AUTRE' || mode === 'WAVE');
    libPrec.textContent = mode === 'AUTRE' ? 'Application utilisée' : 'Référence de la transaction (facultatif)';
    erreur.textContent = '';
    if (seance) {
      resume.textContent = s.avance >= 1
        ? `Une séance en avance sera utilisée. Il lui en restera ${s.avance - 1}.`
        : "Cet élève n'a aucune séance en avance.";
      valider.disabled = s.avance < 1;
    } else {
      const rd = Math.min(entier(rendu.value), Math.max(0, r - tarif));
      const reste = r - rd - tarif;
      resume.textContent = `Encaissé : ${fcfa(r - rd)}. ` + (reste === 0 ? 'Le compte est bon.'
        : reste > 0 ? `On lui devra ${fcfa(reste)} (monnaie à rendre plus tard).`
        : `Il devra ${fcfa(-reste)} (à régler plus tard).`);
      valider.disabled = false;
    }
  }
  recu.addEventListener('input', () => { rendu.value = Math.max(0, entier(recu.value) - tarif); maj(); });
  rendu.addEventListener('input', maj);

  async function envoyer(ev) {
    ev.preventDefault();
    const p = { niveau, id: s.id, mode, recu: recu.value, rendu: rendu.value, precision: prec.value, ref };
    try { calculerEncaissement(p, tarif, s.avance); } catch (e) { erreur.textContent = e.message; return; }
    valider.disabled = true; valider.textContent = 'Enregistrement…';
    try {
      await operationCaisse('encaisser', p);
      dlg.close();
      toast(`Encaissement enregistré pour ${s.nom || "l'élève"}.`);
    } catch (e) {
      erreur.textContent = e.message;
      valider.disabled = false; valider.textContent = "Enregistrer l'encaissement";
    }
  }

  dlg.replaceChildren(h('form', { class: 'params', onsubmit: envoyer },
    h('h2', { id: 'dlg-titre' }, `Encaisser : ${s.nom || '(sans nom)'}`),
    h('p', null, `Montant de la séance : `, h('b', null, fcfa(tarif)),
      s.solde !== 0 && h('span', { class: `solde-note ${s.solde > 0 ? 'du' : 'dette'}` }, ` · ${soldeTexte(s)}`)),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Mode de paiement' }, boutons),
    lRecu, lRendu, lPrec, resume, erreur,
    h('datalist', { id: 'operateurs' }, OPERATEURS.map(o => h('option', { value: o }))),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'secondaire', onclick: () => dlg.close() }, 'Annuler'), valider)));
  maj();
  dlg.showModal();
}

function ouvrirRegler(s, niveau) {
  const dlg = $('#dlg');
  const dette = s.solde < 0;          // l'élève nous doit de l'argent
  const montant = h('input', { type: 'number', min: 1, max: Math.abs(s.solde), step: 50, inputmode: 'numeric', value: Math.abs(s.solde) });
  const mode = h('select', null, MODES.filter(m => m.v !== 'SEANCE').map(m => h('option', { value: m.v }, m.label)));
  const prec = h('input', { type: 'text', maxlength: 80, list: 'operateurs', autocomplete: 'off' });
  const lPrec = champForm('Application ou référence', prec);
  const erreur = h('p', { class: 'erreur', role: 'alert' });
  const valider = h('button', { type: 'submit', class: 'primaire' }, dette ? 'Enregistrer son paiement' : 'Enregistrer le remboursement');
  const maj = () => { lPrec.hidden = mode.value === 'ESPECES'; };
  mode.addEventListener('change', maj);
  const ref = nouvelleRef();

  async function envoyer(ev) {
    ev.preventDefault();
    const p = { niveau, id: s.id, montant: montant.value, mode: mode.value, precision: prec.value, ref };
    try { calculerReglement(p, s.solde); } catch (e) { erreur.textContent = e.message; return; }
    valider.disabled = true;
    try { await operationCaisse('regler', p); dlg.close(); toast('Solde mis à jour.'); }
    catch (e) { erreur.textContent = e.message; valider.disabled = false; }
  }
  dlg.replaceChildren(h('form', { class: 'params', onsubmit: envoyer },
    h('h2', { id: 'dlg-titre' }, `Solde : ${s.nom || '(sans nom)'}`),
    h('p', null, dette ? `Il doit ${fcfa(-s.solde)} (séances ou monnaie non réglées).` : `On lui doit ${fcfa(s.solde)} (monnaie à lui rendre).`),
    champForm(dette ? 'Montant payé par l\'élève (FCFA)' : 'Montant rendu à l\'élève (FCFA)', montant),
    champForm('Mode', mode), lPrec, erreur,
    h('datalist', { id: 'operateurs' }, OPERATEURS.map(o => h('option', { value: o }))),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'secondaire', onclick: () => dlg.close() }, 'Annuler'), valider)));
  maj();
  dlg.showModal();
}

/* ---------- Vue « Séance » ---------- */
async function actualiser() {
  const msg = `Actualiser les séances de ${state.niveau} ?\n\n` +
    'Le tampon prend la valeur du nombre de séances et toutes les présences repassent à « En attente ». ' +
    'À faire une seule fois par séance, quand tous les formateurs ont fini de saisir.';
  if (!confirm(msg)) return;
  await commit('actualiser', { niveau: state.niveau });
  toast(`Séances ${state.niveau} actualisées.`);
}

function ligneSeance(s) {
  return h('li', { class: 'ligne' },
    h('span', { class: 'num' }, s.id),
    h('div', { class: 'identite' },
      h('strong', null, s.nom || '(sans nom)'),
      h('span', { class: 'detail' }, `Tampon : ${s.tampon}` + (s.avance ? `, ${s.avance} en avance` : '')),
      boutonSolde(s, state.niveau)),
    chips(s),
    paiementCellule(s),
    h('span', { class: 'total', title: 'Nombre de séances après la présence saisie' },
      h('b', null, seances(s)), h('small', null, 'Séances')));
}

function vueSeance() {
  const l = liste();
  const cnt = Object.fromEntries(PRESENCES.map(p => [p.v, 0]));
  l.forEach(s => { cnt[s.presence] = (cnt[s.presence] || 0) + 1; });
  const payes = l.filter(s => encaissementDuJour(state.niveau, s.id)).length;
  return h('div', null,
    h('div', { class: 'barre' },
      recherche(),
      h('p', { class: 'bilan' },
        PRESENCES.map(p => h('span', { class: `pastille ${p.cls}` }, `${p.label} : ${cnt[p.v]}`)),
        h('span', { class: 'pastille' }, `Encaissés : ${payes}`)),
      state.role === 'admin' && h('button', { type: 'button', class: 'secondaire', onclick: actualiser }, 'Actualiser les séances')),
    l.length ? h('ul', { class: 'lignes' }, filtrer(l).map(ligneSeance)) : vide());
}

/* ---------- Vue « Fiche élève » ---------- */
const champ = (lib, val) => h('div', { class: 'champ' }, h('dt', null, lib), h('dd', null, val));

function vueFiche() {
  const l = liste();
  if (!l.length) return vide();
  const s = l.find(x => x.id === state.choix[state.niveau]) || l[0];
  state.choix[state.niveau] = s.id;
  const i = l.indexOf(s);
  const aller = id => { state.choix[state.niveau] = id; render(); };
  const tarif = state.settings.tarif;
  const sel = h('select', {
    'aria-label': 'Choisir un élève',
    onchange: e => aller(Number(e.target.value)),
  }, l.map(x => h('option', { value: x.id }, `${x.id}. ${x.nom || '(sans nom)'}`)));
  sel.value = s.id;
  return h('div', null,
    h('div', { class: 'barre' }, sel,
      h('button', { type: 'button', class: 'secondaire', disabled: i === 0, onclick: () => aller(l[i - 1].id) }, 'Précédent'),
      h('button', { type: 'button', class: 'secondaire', disabled: i === l.length - 1, onclick: () => aller(l[i + 1].id) }, 'Suivant')),
    h('article', { class: 'fiche' },
      h('header', { class: 'fiche-tete' }, h('h2', null, 'Kouakou~Renfo'), h('p', null, 'la merveille au rendez-vous')),
      h('div', { class: 'fiche-ligne' },
        h('p', null, h('span', { class: 'lib' }, 'Date de séance : '), dateFr()),
        h('p', null, h('span', { class: 'lib' }, "N° d'ordre : "), s.id)),
      h('h3', { class: 'fiche-nom' }, s.nom || '(sans nom)'),
      h('div', { class: 'fiche-corps' },
        h('dl', { class: 'bloc ciel' },
          champ('Contact', s.contact || '—'), champ('E-mail', s.email || '—'),
          champ("Niveau d'étude", state.niveau), champ('Filière', s.filiere || '—')),
        h('dl', { class: 'bloc' },
          champ("Statut d'inscription", s.statut), champ('Séances en avance', s.avance),
          champ('Montant des avances', fcfa(s.avance * tarif)), champ('Séances non réglées', s.arriere),
          champ('Montant des arriérés', fcfa(s.arriere * tarif)), champ('Redevance', fcfa(s.redevance)),
          champ('Créance', fcfa(s.creance)),
          champ('Solde', boutonSolde(s, state.niveau) || soldeTexte(s)))),
      h('div', { class: 'fiche-pied' },
        h('span', { class: 'lib' }, 'Présence du jour'), chips(s), paiementCellule(s))));
}

/* ---------- Vue « Base de données » ---------- */
function ligneBase(s, admin) {
  const tr = h('tr', { 'data-id': s.id });
  const maj = () => {
    const t = state.settings.tarif;
    tr.querySelector('.m-av').textContent = fcfa(s.avance * t);
    tr.querySelector('.m-ar').textContent = fcfa(s.arriere * t);
    tr.querySelector('.sc').textContent = seances(s);
  };
  const modifier = (k, valeur) => {
    commit('updateStudent', { niveau: state.niveau, id: s.id, patch: { [k]: valeur } }, { silencieux: true });
    maj();
  };
  const texte = (k, type = 'text') => admin
    ? h('input', { type, value: s[k], 'aria-label': `${k} de ${s.nom || "l'élève"}`, onchange: e => modifier(k, e.target.value.trim()) })
    : s[k];
  const nombre = k => admin
    ? h('input', { type: 'number', min: 0, step: 1, value: s[k], 'aria-label': `${k} de ${s.nom || "l'élève"}`,
        onchange: e => { const v = entier(e.target.value); e.target.value = v; modifier(k, v); } })
    : s[k];
  const choix = (opts, k, onchange) => {
    const el = h('select', { 'aria-label': `${k} de ${s.nom || "l'élève"}`, disabled: !admin && k !== 'presence', onchange },
      opts.map(([v, lib]) => h('option', { value: v }, lib)));
    el.value = s[k];
    return el;
  };
  const cellules = [
    h('td', { class: 'nombre' }, s.id),
    h('td', null, texte('nom')),
    h('td', null, texte('contact', 'tel')),
    h('td', null, texte('email', 'email')),
    h('td', null, texte('filiere')),
    h('td', null, choix([['OUI', 'OUI'], ['NON', 'NON']], 'statut', e => modifier('statut', e.target.value))),
    h('td', { class: 'nombre' }, nombre('avance')),
    h('td', { class: 'nombre m-av' }, fcfa(s.avance * state.settings.tarif)),
    h('td', { class: 'nombre' }, nombre('arriere')),
    h('td', { class: 'nombre m-ar' }, fcfa(s.arriere * state.settings.tarif)),
    h('td', { class: 'nombre' }, nombre('creance')),
    h('td', { class: 'nombre' }, nombre('redevance')),
    h('td', { class: 'nombre' }, soldeTexte(s)),
    h('td', null, choix(PRESENCES.map(p => [p.v, p.label]), 'presence', e => {
      commit('setPresence', { niveau: state.niveau, id: s.id, presence: e.target.value }, { silencieux: true });
      maj();
    })),
    h('td', { class: 'nombre sc' }, seances(s)),
    h('td', { class: 'nombre' }, nombre('tampon')),
    admin && h('td', null, h('button', {
      type: 'button', class: 'secondaire danger', onclick: async () => {
        if (confirm(`Supprimer ${s.nom || 'cet élève'} de ${state.niveau} ?`)) {
          await commit('deleteStudent', { niveau: state.niveau, id: s.id });
        }
      },
    }, 'Supprimer')),
  ];
  tr.append(...cellules.filter(Boolean));
  return tr;
}

const cellCSV = v => {
  let t = String(v ?? '');
  if (/^([=@]|[+-](?![\d\s]))/.test(t)) t = "'" + t; // neutralise les formules dans Excel
  return /[;"\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
function telecharger(blob, nom) {
  const a = h('a', { href: URL.createObjectURL(blob), download: nom });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const telechargerCSV = (lignes, nom) => telecharger(
  new Blob(['\ufeff' + lignes.map(r => r.map(cellCSV).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), nom);

function exporterCSV() {
  telechargerCSV([CHAMPS.map(c => c[1]), ...liste().map(s => CHAMPS.map(([k]) => s[k]))],
    `renfo_${state.niveau}_${aujourdhui()}.csv`);
}

function parseCSV(txt) {
  txt = txt.replace(/^\ufeff/, '');
  const premiere = txt.split(/\r?\n/, 1)[0];
  const d = (premiere.match(/;/g) || []).length >= (premiere.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

function elevesDepuisCSV(texte) {
  const lignes = parseCSV(texte);
  if (lignes.length < 2) throw new Error('Le fichier ne contient aucune ligne de données.');
  const carte = {};
  CHAMPS.forEach(([k, lib]) => { carte[norm(k)] = k; carte[norm(lib)] = k; });
  Object.assign(carte, ALIAS_ENTETES);
  const cols = lignes[0].map(e => carte[norm(e)] || null);
  if (!cols.includes('nom')) throw new Error("Colonne « Nom et prénoms » introuvable sur la première ligne.");
  const out = [];
  for (const r of lignes.slice(1)) {
    const s = nouvelEleve(0);
    cols.forEach((k, i) => {
      if (!k) return;
      const v = (r[i] ?? '').trim();
      if (!NOMBRES.has(k)) { s[k] = v; return; }
      const n = Math.round(Number(v.replace(',', '.'))) || 0;
      s[k] = k === 'solde' ? n : Math.max(0, n);
    });
    if (!s.nom) continue;
    const p = PRESENCES.find(x => x.v.toLowerCase() === String(s.presence).toLowerCase());
    s.presence = p ? p.v : ATTENTE;
    s.statut = String(s.statut).toUpperCase() === 'NON' ? 'NON' : 'OUI';
    out.push(s);
  }
  const ids = out.map(s => s.id);
  if (ids.some(i => i < 1) || new Set(ids).size !== ids.length) out.forEach((s, i) => { s.id = i + 1; });
  return out;
}

async function importerCSV(fichier) {
  try {
    const eleves = elevesDepuisCSV(await fichier.text());
    if (!eleves.length) throw new Error('Aucun élève avec un nom dans le fichier.');
    const soldes = liste().some(s => s.solde !== 0)
      ? '\n\nAttention : des soldes (monnaie due ou dettes) existent ; ils seront remplacés par ceux du fichier.' : '';
    if (!confirm(`Remplacer les ${liste().length} élèves de ${state.niveau} par les ${eleves.length} du fichier ?${soldes}`)) return;
    await commit('replaceStudents', { niveau: state.niveau, students: eleves });
    toast(`${eleves.length} élèves importés en ${state.niveau}.`);
  } catch (e) { toast(e.message, true); }
}

function vueBase() {
  const admin = state.role === 'admin';
  const l = liste();
  const entetes = ['N°', 'Nom et prénoms', 'Contact', 'E-mail', 'Filière', 'Statut', 'Séances en avance',
    'Montant avances', 'Séances non réglées', 'Montant arriérés', 'Créance', 'Redevance', 'Solde', 'Présence',
    'Séances', 'Tampon', admin ? '' : null];
  const fichier = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true,
    onchange: e => { if (e.target.files[0]) importerCSV(e.target.files[0]); e.target.value = ''; } });
  return h('div', null,
    h('div', { class: 'barre' },
      recherche(),
      h('span', { class: 'bilan' }),
      admin && h('button', { type: 'button', class: 'primaire', onclick: async () => {
        const id = prochainId(l);
        await commit('addStudent', { niveau: state.niveau, student: nouvelEleve(id) });
        const champNom = $(`tr[data-id="${id}"] input`);
        if (champNom) champNom.focus();
      } }, 'Ajouter un élève'),
      admin && h('button', { type: 'button', class: 'secondaire', onclick: () => fichier.click() }, 'Importer un CSV'),
      fichier,
      h('button', { type: 'button', class: 'secondaire', onclick: exporterCSV, disabled: !l.length }, 'Exporter en CSV')),
    l.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'base' },
          h('thead', null, h('tr', null, entetes.map(e => e !== null && h('th', { scope: 'col' }, e)))),
          h('tbody', null, filtrer(l).map(s => ligneBase(s, admin)))))
      : vide());
}

/* ---------- Vue « Caisse » (administrateur) ---------- */
async function changerDate(v) {
  state.caisseDate = v;
  if (state.conn.url && v && v !== jour()) {
    try { state.caisseJours[v] = (await appeler('paiements', { date: v })).paiements; }
    catch (e) { toast(e.message, true); }
  }
  render();
}

function paiementsDuJour(date) {
  if (!state.conn.url || date === jour()) return state.paiements.filter(r => r.date === date);
  return state.caisseJours[date] || [];
}

async function annulerOperation(o) {
  if (!confirm(`Annuler cette opération pour ${o.nom || "l'élève"} ?\n\nLe solde et les séances en avance de l'élève seront remis comme avant. L'annulation reste visible dans la caisse.`)) return;
  try { await operationCaisse('annuler', { niveau: o.niveau, cible: o.ref, ref: nouvelleRef() }); toast('Opération annulée.'); }
  catch (e) { toast(e.message, true); }
}

function exporterCaisse(rows, date) {
  telechargerCSV([
    ['Date', 'Heure', 'Niveau', "N° d'ordre", 'Nom', 'Opération', 'Mode', 'Précision', 'Montant séance', 'Remis', 'Rendu',
      'Encaissé net', 'Effet sur le solde', 'Séances en avance', 'Enregistré par', 'Annulée'],
    ...rows.map(r => [r.date, heure(r.horodatage), r.niveau, r.eleve, r.nom, LIB_TYPE[r.type], LIB_MODE[r.mode], r.precision,
      r.du, r.recu, r.rendu, r.net, r.effetSolde, r.effetAvance, r.utilisateur, r.annulePar ? 'oui' : '']),
  ], `caisse_${date}.csv`);
}

function vueCaisse() {
  if (state.role !== 'admin') return h('div', { class: 'vide' }, h('p', null, 'La caisse est réservée aux administrateurs.'));
  const date = state.caisseDate || jour();
  const tous = state.caisseTous;
  const rows = paiementsDuJour(date).filter(r => tous || r.niveau === state.niveau)
    .sort((a, b) => String(a.horodatage).localeCompare(String(b.horodatage)));
  const parMode = MODES.filter(m => m.v !== 'SEANCE').map(m => {
    const rs = rows.filter(r => r.mode === m.v);
    return { m, net: rs.reduce((t, r) => t + r.net, 0), n: rs.filter(r => r.type === 'ENCAISSEMENT' && !r.annulePar).length };
  });
  const total = parMode.reduce((t, x) => t + x.net, 0);
  const viaSeance = rows.filter(r => r.type === 'ENCAISSEMENT' && r.mode === 'SEANCE' && !r.annulePar).length;
  const eleves = (tous ? NIVEAUX : [state.niveau]).flatMap(n => state.data[n].map(s => ({ n, s })));
  const aRendre = eleves.filter(x => x.s.solde > 0), aEncaisser = eleves.filter(x => x.s.solde < 0);
  const somme = l => l.reduce((t, x) => t + Math.abs(x.s.solde), 0);

  const listeSoldes = (titre, l, action) => h('section', { class: 'soldes' },
    h('h3', null, `${titre} : ${fcfa(somme(l))}`),
    l.length ? h('ul', null, l.map(({ n, s }) => h('li', null,
      h('span', null, `${tous ? n + ' – ' : ''}${s.nom || '(sans nom)'}`), h('b', null, fcfa(Math.abs(s.solde))),
      h('button', { type: 'button', class: 'secondaire', onclick: () => ouvrirRegler(s, n) }, action))))
      : h('p', { class: 'detail' }, 'Aucun.'));

  return h('div', null,
    h('div', { class: 'barre' },
      h('label', { class: 'cf ligne-h' }, h('span', null, 'Jour'),
        h('input', { type: 'date', value: date, max: jour(), onchange: e => changerDate(e.target.value) })),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: tous || null,
        onchange: e => { state.caisseTous = e.target.checked; render(); } }), 'Tous les niveaux'),
      h('span', { class: 'bilan' }),
      h('button', { type: 'button', class: 'secondaire', disabled: !rows.length, onclick: () => exporterCaisse(rows, date) }, 'Exporter en CSV')),
    h('section', { class: 'recap' },
      h('table', null,
        h('thead', null, h('tr', null, ['Mode', 'Séances payées', 'Encaissé net'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', null,
          parMode.map(x => h('tr', null, h('td', null, x.m.label), h('td', { class: 'nombre' }, x.n), h('td', { class: 'nombre' }, fcfa(x.net)))),
          h('tr', null, h('td', null, LIB_MODE.SEANCE), h('td', { class: 'nombre' }, viaSeance), h('td', { class: 'nombre' }, '—'))),
        h('tfoot', null, h('tr', null, h('th', null, 'Total encaissé'), h('td', null), h('td', { class: 'nombre' }, fcfa(total))))),
      h('p', { class: 'detail' }, "Encaissé net = montants remis moins monnaie rendue, plus les règlements de soldes payés par les élèves, moins ceux rendus aux élèves.")),
    h('div', { class: 'deux' },
      listeSoldes('Monnaie à rendre aux élèves', aRendre, 'Rendre'),
      listeSoldes('À encaisser auprès des élèves', aEncaisser, 'Encaisser')),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Heure', 'Élève', 'Opération', 'Mode', 'Remis', 'Rendu', 'Encaissé net', 'Solde', 'Par', '']
        .map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', null, rows.map(r => h('tr', { class: r.annulePar || r.type === 'ANNULATION' ? 'annule' : null },
        h('td', null, heure(r.horodatage)),
        h('td', null, `${tous ? r.niveau + ' – ' : ''}${r.nom}`),
        h('td', null, LIB_TYPE[r.type]),
        h('td', null, libPaiement(r) + (r.mode === 'WAVE' && r.precision ? ` (${r.precision})` : '')),
        h('td', { class: 'nombre' }, r.recu), h('td', { class: 'nombre' }, r.rendu), h('td', { class: 'nombre' }, r.net),
        h('td', { class: 'nombre' }, r.effetSolde), h('td', null, r.utilisateur),
        h('td', null, r.type !== 'ANNULATION' && !r.annulePar && h('button', { type: 'button', class: 'secondaire danger',
          onclick: () => annulerOperation(r) }, 'Annuler'))))))
      ) : h('div', { class: 'vide' }, h('p', null, 'Aucune opération ce jour-là.')));
}

/* ---------- Connexion et paramètres ---------- */
function panneauConnexion() {
  const code = h('input', { type: 'password', autocomplete: 'off', required: true, 'aria-label': "Code d'accès" });
  const garder = h('input', { type: 'checkbox' });
  const bouton = h('button', { type: 'submit', class: 'primaire' }, 'Se connecter');
  return h('form', { class: 'connexion', onsubmit: async ev => {
    ev.preventDefault();
    const c = code.value.trim();
    if (!c) return;
    bouton.disabled = true;
    state.conn.code = c;
    if (await recharger(false)) {
      try { (garder.checked ? localStorage : sessionStorage).setItem(CLE_CODE, c); } catch (_) { /* rien */ }
    } else { state.conn.code = ''; render(); }
  } },
    h('h2', null, 'Connexion'),
    h('p', null, 'Saisissez votre code personnel.'),
    h('label', { class: 'cf' }, h('span', null, "Code d'accès"), code),
    h('label', { class: 'case' }, garder, 'Rester connecté sur cet appareil (à éviter sur un ordinateur partagé)'),
    bouton);
}

function ouvrirParams() {
  const dlg = $('#dlg');
  const url = h('input', { type: 'url', placeholder: 'https://script.google.com/macros/s/…/exec', value: state.conn.url });
  const tarif = h('input', { type: 'number', min: 0, step: 50, value: state.settings.tarif });
  const fermer = () => dlg.close();

  async function enregistrer(ev) {
    ev.preventDefault();
    const nouvelle = url.value.trim();
    if (nouvelle !== state.conn.url) {
      try { if (nouvelle) localStorage.setItem(CLE_URL, nouvelle); else localStorage.removeItem(CLE_URL); } catch (_) { /* rien */ }
      oublierCode();
      state.conn.url = nouvelle;
      if (!nouvelle) chargerLocal();
      render(); fermer(); return;
    }
    const t = entier(tarif.value);
    if (state.role === 'admin' && t && t !== state.settings.tarif) await commit('setSettings', { settings: { tarif: t } });
    fermer();
  }

  dlg.replaceChildren(h('form', { class: 'params', onsubmit: enregistrer },
    h('h2', { id: 'dlg-titre' }, 'Paramètres'),
    h('label', { class: 'cf' }, h('span', null, 'Adresse du service en ligne'), url,
      h('small', null, 'Laissez vide pour travailler seulement dans ce navigateur (essai).')),
    h('label', { class: 'cf' }, h('span', null, 'Tarif par séance (FCFA)'), tarif,
      h('small', null, state.role === 'admin' ? 'Sert aux encaissements et aux montants des avances et arriérés.' : 'Modifiable par un administrateur.')),
    h('div', { class: 'actions' },
      state.conn.url && state.conn.code && h('button', { type: 'button', class: 'secondaire',
        onclick: () => { oublierCode(); render(); fermer(); } }, 'Se déconnecter'),
      h('button', { type: 'button', class: 'secondaire', onclick: fermer }, 'Fermer'),
      h('button', { type: 'submit', class: 'primaire' }, 'Enregistrer'))));
  tarif.disabled = state.role !== 'admin';
  dlg.showModal();
}

/* ---------- Rendu et navigation ---------- */
function majEtat() {
  const el = $('#etat');
  $('#btn-rafraichir').hidden = !(state.conn.url && state.conn.code && state.charge);
  const role = state.role === 'admin' ? 'Administrateur' : 'Formateur';
  if (state.conn.url && !state.charge) { el.textContent = 'Non connecté'; el.className = ''; return; }
  const lieu = !state.conn.url ? 'mode local (ce navigateur)' : state.hors_ligne ? 'hors ligne' : 'en ligne';
  const qui = state.conn.url && state.utilisateur ? `${state.utilisateur} (${role.toLowerCase()})` : role;
  el.textContent = `${qui}, ${lieu}`;
  el.className = state.hors_ligne ? 'hors' : '';
}

function majNav() {
  document.querySelectorAll('.niveaux a').forEach(a => {
    a.href = `#/${a.dataset.niveau}/${state.vue}`;
    if (a.dataset.niveau === state.niveau) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function vueNiveau() {
  const n = liste().length;
  const onglets = [['seance', 'Séance'], ['fiche', 'Fiche élève'], ['base', 'Base de données']];
  if (state.role === 'admin') onglets.push(['caisse', 'Caisse']);
  const vue = onglets.some(o => o[0] === state.vue) ? state.vue : 'seance';
  const contenu = { seance: vueSeance, fiche: vueFiche, base: vueBase, caisse: vueCaisse }[vue]();
  return h('section', null,
    h('div', { class: 'entete' }, h('h1', null, `Niveau ${state.niveau}`),
      h('p', { class: 'sous' }, `${n} ${n > 1 ? 'élèves' : 'élève'}`)),
    h('nav', { class: 'onglets', 'aria-label': 'Sections' },
      onglets.map(([v, lib]) => h('a', { href: `#/${state.niveau}/${v}`, 'aria-current': v === vue ? 'page' : null }, lib))),
    contenu);
}

function render() {
  majNav(); majEtat();
  const app = $('#app');
  const foc = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  const y = window.scrollY;
  if (state.conn.url && !state.conn.code) { app.replaceChildren(panneauConnexion()); return; }
  if (state.conn.url && !state.charge) {
    app.replaceChildren(h('div', { class: 'vide' },
      h('p', null, state.erreur || 'Chargement des données…'),
      state.erreur && h('button', { type: 'button', class: 'secondaire', onclick: () => recharger(false) }, 'Réessayer')));
    return;
  }
  app.replaceChildren(vueNiveau());
  window.scrollTo(0, y);
  if (foc) {
    const el = app.querySelector(`[data-k="${foc}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (foc === 'filtre') el.setSelectionRange(el.value.length, el.value.length);
    }
  }
}

function route() {
  const [, n, v] = location.hash.split('/');
  const memo = localStorage.getItem(CLE_NIVEAU);
  state.niveau = NIVEAUX.includes(n) ? n : (NIVEAUX.includes(memo) ? memo : 'L1');
  state.vue = VUES.includes(v) ? v : 'seance';
  state.filtre = '';
  try { localStorage.setItem(CLE_NIVEAU, state.niveau); } catch (_) { /* sans importance */ }
  render();
}

function init() {
  state.conn = lireConn();
  if (!state.conn.url) chargerLocal();
  $('#btn-params').addEventListener('click', ouvrirParams);
  $('#btn-rafraichir').addEventListener('click', async () => { if (await recharger(false)) toast('Données à jour.'); });
  window.addEventListener('hashchange', route);
  route();
  if (state.conn.url && state.conn.code) recharger(false);
  // Une vérification par minute : suffisant pour voir les encaissements des collègues sans épuiser le quota Google
  setInterval(() => { if (!document.hidden) recharger(true); }, 60000);
}

init();
