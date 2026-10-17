/**
 * The string catalogue — every label a generated document prints.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE IN GIT AND NOT IN A DATABASE, AND NOT FROM A MODEL
 *
 * The same argument that put the knowledge corpus in git, for the same reasons.
 *
 * These strings are the furniture of a document that goes to an investor:
 * "Confirmed from", "Where every figure came from", "Illustrative example". They
 * are read as statements by the company issuing the document. A machine
 * translation of "Confirmed from accounts.pdf p.4" that comes out meaning
 * "Approved by" is a materially different claim about provenance, made in a
 * language the issuer cannot check.
 *
 * In git they are versioned, reviewed, diffable and dated. In a table they could
 * change without code review. From a model they could change between two
 * renderings of the same document.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * EVERY STRING HERE WAS WRITTEN, NOT GENERATED
 *
 * That is a claim this file has to keep being able to make, so a new locale is
 * added by a person who speaks the language, not by translating this file. If
 * nobody has done that work, the locale is not offered — which is why there are
 * four and not forty.
 *
 * A missing string falls back to English rather than rendering a key. A document
 * with "doc.appendix.heading" printed in it is unmistakably broken; one with an
 * English heading in a French document is merely unfinished, and the fallback is
 * reported so it can be fixed.
 */

export const CATALOGUE_VERSION = '1.0';

/**
 * Keyed by string, then by locale.
 *
 * Grouped by where it appears, because a translator reviewing this file needs to
 * know whether a word is a page heading or a table column — "Source" is a
 * different word in French depending on which.
 */
const STRINGS = {
  // ── document furniture ──
  'doc.appendix.heading': {
    'en-GB': 'Where every figure came from',
    'en-US': 'Where every figure came from',
    'fr-FR': 'Origine de chaque chiffre',
    'de-DE': 'Herkunft jeder Zahl',
    'es-ES': 'Origen de cada cifra',
  },
  'doc.appendix.note': {
    'en-GB': 'Each figure in this document is a reference into the company\'s own fact store. '
           + 'Nothing was typed, and nothing was estimated.',
    'en-US': 'Each figure in this document is a reference into the company\'s own fact store. '
           + 'Nothing was typed, and nothing was estimated.',
    'fr-FR': 'Chaque chiffre de ce document renvoie au référentiel de données de la société. '
           + 'Aucun chiffre n\'a été saisi ni estimé.',
    'de-DE': 'Jede Zahl in diesem Dokument verweist auf den Datenbestand des Unternehmens. '
           + 'Nichts wurde eingetippt und nichts geschätzt.',
    'es-ES': 'Cada cifra de este documento remite al repositorio de datos de la empresa. '
           + 'Nada se ha escrito a mano ni se ha estimado.',
  },
  'doc.column.figure': {
    'en-GB': 'Figure', 'en-US': 'Figure', 'fr-FR': 'Chiffre', 'de-DE': 'Kennzahl', 'es-ES': 'Cifra',
  },
  'doc.column.value': {
    'en-GB': 'Value', 'en-US': 'Value', 'fr-FR': 'Valeur', 'de-DE': 'Wert', 'es-ES': 'Valor',
  },
  'doc.column.period': {
    'en-GB': 'Period', 'en-US': 'Period', 'fr-FR': 'Période', 'de-DE': 'Zeitraum', 'es-ES': 'Periodo',
  },
  'doc.column.source': {
    'en-GB': 'Source', 'en-US': 'Source', 'fr-FR': 'Source', 'de-DE': 'Quelle', 'es-ES': 'Fuente',
  },
  'doc.column.how_it_got_here': {
    'en-GB': 'How it got here',
    'en-US': 'How it got here',
    'fr-FR': 'Provenance',
    'de-DE': 'Wie sie hierher kam',
    'es-ES': 'Cómo llegó aquí',
  },
  'doc.column.confirmed': {
    'en-GB': 'Confirmed', 'en-US': 'Confirmed', 'fr-FR': 'Confirmé le', 'de-DE': 'Bestätigt',
    'es-ES': 'Confirmado',
  },
  // Two strings, not one with an optional clause. A fact confirmed from a
  // document with no page number renders the second; a template with an empty
  // placeholder in it would print "p." followed by nothing.
  'doc.source.confirmed_from_page': {
    'en-GB': 'Confirmed from {document}, p.{page}',
    'en-US': 'Confirmed from {document}, p.{page}',
    'fr-FR': 'Confirmé d\'après {document}, p.{page}',
    'de-DE': 'Bestätigt aus {document}, S.{page}',
    'es-ES': 'Confirmado a partir de {document}, p.{page}',
  },
  'doc.source.confirmed_from': {
    'en-GB': 'Confirmed from {document}',
    'en-US': 'Confirmed from {document}',
    'fr-FR': 'Confirmé d\'après {document}',
    'de-DE': 'Bestätigt aus {document}',
    'es-ES': 'Confirmado a partir de {document}',
  },
  'doc.source.a_document': {
    'en-GB': 'a document', 'en-US': 'a document', 'fr-FR': 'un document',
    'de-DE': 'einem Dokument', 'es-ES': 'un documento',
  },
  'doc.source.entered_by_hand': {
    'en-GB': 'Entered by hand',
    'en-US': 'Entered by hand',
    'fr-FR': 'Saisi manuellement',
    'de-DE': 'Manuell erfasst',
    'es-ES': 'Introducido manualmente',
  },
  'doc.absent': {
    'en-GB': 'Not recorded', 'en-US': 'Not recorded', 'fr-FR': 'Non renseigné',
    'de-DE': 'Nicht erfasst', 'es-ES': 'No registrado',
  },
  'doc.as_at': {
    'en-GB': 'As at {date}', 'en-US': 'As of {date}', 'fr-FR': 'Au {date}',
    'de-DE': 'Stand {date}', 'es-ES': 'A fecha de {date}',
  },

  // ── chart and table furniture ──
  'chart.no_data': {
    'en-GB': 'Not enough recorded to draw this yet.',
    'en-US': 'Not enough recorded to draw this yet.',
    'fr-FR': 'Données insuffisantes pour établir ce graphique.',
    'de-DE': 'Noch nicht genug erfasst, um dies darzustellen.',
    'es-ES': 'Todavía no hay datos suficientes para este gráfico.',
  },
  'chart.share_of_revenue': {
    'en-GB': 'Share of revenue',
    'en-US': 'Share of revenue',
    'fr-FR': 'Part du chiffre d\'affaires',
    'de-DE': 'Umsatzanteil',
    'es-ES': 'Porcentaje de ingresos',
  },
  'table.total': {
    'en-GB': 'Total', 'en-US': 'Total', 'fr-FR': 'Total', 'de-DE': 'Gesamt', 'es-ES': 'Total',
  },

  // ── states a reader needs in words, never only in colour ──
  'state.present': {
    'en-GB': 'Present', 'en-US': 'Present', 'fr-FR': 'Fourni', 'de-DE': 'Vorhanden', 'es-ES': 'Aportado',
  },
  'state.missing': {
    'en-GB': 'Missing', 'en-US': 'Missing', 'fr-FR': 'Manquant', 'de-DE': 'Fehlt', 'es-ES': 'Falta',
  },
  'state.not_applicable': {
    'en-GB': 'Not applicable', 'en-US': 'Not applicable', 'fr-FR': 'Sans objet',
    'de-DE': 'Nicht zutreffend', 'es-ES': 'No aplicable',
  },

  // ── the illustrative-example notice ──
  //
  // Carried verbatim wherever an invented example appears. Translated here
  // because it has to be understood by the reader to do its job at all — a
  // notice saying "this is not real" in a language the reader does not speak is
  // not a notice.
  'notice.illustrative': {
    'en-GB': 'Illustrative example. Not a real company, client, engagement, or performance result. '
           + 'All names, figures, workflows, and outcomes are invented for teaching purposes.',
    'en-US': 'Illustrative example. Not a real company, client, engagement, or performance result. '
           + 'All names, figures, workflows, and outcomes are invented for teaching purposes.',
    'fr-FR': 'Exemple illustratif. Ne correspond à aucune société, aucun client, aucune mission ni '
           + 'aucun résultat réels. Tous les noms, chiffres, processus et résultats sont inventés à '
           + 'des fins pédagogiques.',
    'de-DE': 'Illustratives Beispiel. Kein reales Unternehmen, kein realer Kunde, kein reales Mandat '
           + 'und kein reales Ergebnis. Alle Namen, Zahlen, Abläufe und Ergebnisse sind zu '
           + 'Lehrzwecken erfunden.',
    'es-ES': 'Ejemplo ilustrativo. No corresponde a ninguna empresa, cliente, encargo ni resultado '
           + 'reales. Todos los nombres, cifras, procesos y resultados son inventados con fines '
           + 'didácticos.',
  },
};

export const STRING_KEYS = Object.freeze(Object.keys(STRINGS));

/**
 * Look up a string, substituting any `{placeholders}`.
 *
 * Falls back to English and REPORTS the fallback, so an unfinished locale shows
 * up in a report rather than only in a rendered PDF.
 */
export function t(key, locale, values = {}) {
  const entry = STRINGS[key];
  if (!entry) {
    // A missing KEY is a bug in the caller, not an unfinished translation, and a
    // document printing a key is unmistakably broken.
    throw new Error(`no string for key "${key}"`);
  }

  const exact = entry[locale];
  const fallback = entry['en-GB'];
  const text = exact ?? fallback;

  return {
    text: substitute(text, values),
    fell_back: !exact,
    key,
  };
}

/** The usual case, where a caller just wants the words. */
export const s = (key, locale, values = {}) => t(key, locale, values).text;

function substitute(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    (name in values ? String(values[name]) : whole));
}

/**
 * Which strings a locale is still missing.
 *
 * A locale is only offered once this is empty, which is what keeps the claim at
 * the top of this file true.
 */
export function missingFor(locale) {
  return STRING_KEYS.filter((key) => !STRINGS[key][locale]);
}

export function coverage() {
  const locales = [...new Set(Object.values(STRINGS).flatMap((e) => Object.keys(e)))];
  return locales.map((locale) => ({
    locale,
    missing: missingFor(locale),
    complete: missingFor(locale).length === 0,
  }));
}
