const ALGOLIA_APP_ID = '6X0Y0UTRKB';
const ALGOLIA_API_KEY = 'cb085d1f940a1df7dc1b45f682311c5b';
const ALGOLIA_INDEX = 'wp_recettes';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_PROXY_URL = 'https://app-b9d9b3e4-02af-4c9a-8dcc-e8798eb83626.cleverapps.io/api/anthropic/messages';

function getCurrentSeason(date = new Date()) {
  const md = (date.getMonth() + 1) * 100 + date.getDate();
  if (md >= 321 && md <= 620) return 'Printemps';
  if (md >= 621 && md <= 922) return 'Été';
  if (md >= 923 && md <= 1220) return 'Automne';
  return 'Hiver';
}

function audienceFilters(audience, ageBucket) {
  if (audience === 'baby') {
    if (!ageBucket) throw new Error("Date de naissance du bébé requise.");
    return [`age:"${ageBucket}"`, 'NOT type:"Parents-bébé"'];
  }
  if (audience === 'family-baby') {
    return ['type:"Parents-bébé"'];
  }
  return ['age:"pour la famille"'];
}

// Cache identical Algolia queries within a session so successive swaps and
// refinements don't re-fetch the same pool. Algolia returns the same hits for
// identical params, and our shuffling/filtering happens on top.
const searchCache = new Map();
const inflightSearches = new Map();

async function searchRecipes({ season, audience = 'family', ageBucket = null, diet = [], excludeDiet = [], query = '', optionalWords = [], hitsPerPage = 500 }) {
  const filterParts = [
    ...audienceFilters(audience, ageBucket),
    `season:"${season}"`,
    '(moment:"Plat du midi" OR moment:"Plat du soir")',
    ...diet.map(d => `diet:"${d}"`),
    ...excludeDiet.map(d => `NOT diet:"${d}"`)
  ];
  const filters = filterParts.join(' AND ');

  const params = [
    `hitsPerPage=${hitsPerPage}`,
    `filters=${encodeURIComponent(filters)}`,
    `query=${encodeURIComponent(query)}`
  ];
  if (optionalWords.length) {
    params.push(`optionalWords=${encodeURIComponent(JSON.stringify(optionalWords))}`);
  }
  const paramsString = params.join('&');

  // Cache hit — return the previous hits (callers don't mutate the array).
  if (searchCache.has(paramsString)) {
    return searchCache.get(paramsString);
  }
  // De-duplicate concurrent requests for the same params.
  if (inflightSearches.has(paramsString)) {
    return inflightSearches.get(paramsString);
  }

  const url = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;
  const promise = (async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Algolia-API-Key': ALGOLIA_API_KEY,
        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ params: paramsString })
    });
    if (!res.ok) throw new Error(`Algolia error: ${res.status}`);
    const data = await res.json();
    const hits = data.hits || [];
    searchCache.set(paramsString, hits);
    return hits;
  })();
  inflightSearches.set(paramsString, promise);
  try {
    return await promise;
  } finally {
    inflightSearches.delete(paramsString);
  }
}

function proteinCategory(recipe) {
  const diet = recipe.diet || [];
  if (diet.includes('Avec viande')) return 'viande';
  if (diet.includes('Avec poisson')) return 'poisson';
  return 'vegan';
}

function isExpress(recipe) {
  return (recipe.extras || []).some(e => e.toLowerCase().includes('express'))
      || (recipe.specials || []).some(s => s.toLowerCase().includes('express'));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickFromBucket(bucket, n, usedIds) {
  const available = bucket.filter(r => !usedIds.has(r.objectID));
  const express = shuffle(available.filter(isExpress));
  const other = shuffle(available.filter(r => !isExpress(r)));

  const targetExpress = Math.min(Math.ceil(n / 2), express.length);
  const picks = express.slice(0, targetExpress);

  let i = 0;
  while (picks.length < n && i < other.length) picks.push(other[i++]);
  let j = targetExpress;
  while (picks.length < n && j < express.length) picks.push(express[j++]);

  return picks;
}

function pickBalanced(pool, n) {
  if (pool.length === 0) return [];

  const targets = {
    viande: Math.round(n * 0.3),
    poisson: Math.round(n * 0.3),
    vegan: 0
  };
  targets.vegan = Math.max(0, n - targets.viande - targets.poisson);

  const buckets = { viande: [], poisson: [], vegan: [] };
  for (const r of pool) buckets[proteinCategory(r)].push(r);

  const picked = [];
  const usedIds = new Set();

  for (const cat of ['viande', 'poisson', 'vegan']) {
    const slice = pickFromBucket(buckets[cat], targets[cat], usedIds);
    for (const r of slice) {
      picked.push(r);
      usedIds.add(r.objectID);
    }
  }

  if (picked.length < n) {
    const rest = pickFromBucket(pool, n - picked.length, usedIds);
    for (const r of rest) {
      picked.push(r);
      usedIds.add(r.objectID);
    }
  }

  return shuffle(picked).slice(0, n);
}

function proteinLabel(cat) {
  return { viande: '🥩 Viande', poisson: '🐟 Poisson', vegan: '🥬 Végé' }[cat];
}

function decodeHtml(s) {
  return s.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

// ===== LLM parsing of free-text precisions =====

const SYSTEM_PROMPT = `Tu transformes une demande en français en filtres JSON pour un générateur de menu famille.

Diètes disponibles (n'utilise QUE ces valeurs exactes) : "Végétarien", "Vegan", "Sans gluten", "Sans PLV", "Sans oeuf", "Avec viande", "Avec poisson"

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, selon ce schéma :
{
  "specific": [],       // plats précis avec un nombre exact, ex: [{"keyword":"quiche","count":1}]
  "must_contain": [],   // ingrédients à intégrer AU MOINS X fois dans le menu global, ex: [{"keyword":"poulet","count":1}]. N'augmente PAS le nombre de repas — un même plat peut satisfaire plusieurs contraintes.
  "diet": [],           // diètes à appliquer (ET logique)
  "exclude_diet": [],   // diètes à exclure
  "include": [],        // préférences douces pour le RESTE du menu (mots-clés singulier)
  "exclude": [],        // mots-clés à exclure complètement (singulier)
  "meals": null,        // nombre TOTAL de repas si mentionné
  "persons": null       // nombre de personnes si mentionné
}

Règles importantes :
1. "sans X" où X est UN ingrédient précis (boeuf, poulet, champignon, lait, gluten, blé...) -> exclude:["X"], PAS exclude_diet.
2. "sans viande" (catégorie globale) -> exclude_diet:["Avec viande"].
3. "sans poisson" (catégorie globale) -> exclude_diet:["Avec poisson"].
4. "sans gluten/lactose/PLV/oeuf" -> diet:["Sans gluten"|"Sans PLV"|"Sans oeuf"] (préférence positive).
5. "végétarien"/"vegan" -> diet:["Végétarien"|"Vegan"].
6. IGNORE complètement les mots "saison", "saisonnier", "saisonnière", "de saison" : la saison est déjà appliquée automatiquement.
7. "1 quiche", "2 pâtes", "un plat avec du riz", "une lasagne" -> specific (compte exact, AJOUTE au nombre de repas). "on aime les pâtes" -> include (préférence douce).
8. Si "1 quiche et 4 autres plats" : meals=5. Si juste "1 quiche" sans nombre total : meals=null.
9. NE renseigne meals QUE si l'utilisateur mentionne EXPLICITEMENT un nombre total ("X repas", "X plats"). N'INFÈRE JAMAIS meals en comptant les items listés. Ex: "lasagnes pizza salade" = meals:null (ne compte PAS 3).
11. "intègre au moins X fois Y" / "AU MOINS 1 plat avec Y" / "1 fois Y, 1 fois Z" formulé comme contrainte d'inclusion globale -> must_contain:[{keyword:"Y",count:X}]. C'est une garantie qu'au moins X plats du menu contiendront Y, mais SANS ajouter de plats supplémentaires. UN MÊME PLAT PEUT SATISFAIRE PLUSIEURS CONTRAINTES (specific ET must_contain) : ex: "1 plat avec riz" + "au moins 1 fois poulet" = riz au poulet (un seul plat couvre les deux).
12. Distinction cruciale :
   - "un plat avec X" / "1 X" (qui exprime un type de plat ou un féculent structurant) -> specific
   - "au moins 1 fois X" / "intègre X" (qui ajoute un INGRÉDIENT à n'importe lequel des plats existants) -> must_contain
   Si tu doutes : un féculent / un format de plat (riz, pâtes, quiche, pommes de terre) = specific ; un type de protéine ou un ingrédient secondaire (poulet, dinde, viande hachée, crevettes) à intégrer = must_contain.
10. La recherche s'effectue sur les titres et ingrédients de recettes françaises bébé/famille. Si l'utilisateur mentionne une CATÉGORIE générique (mijoté, gratin, soupe, sauté, rôti, salade, tarte, crumble, curry, wok...), expanse-la en plusieurs noms concrets de plats que l'on peut trouver dans des titres. Exemples :
   - "mijoté" / "plats mijotés" -> ["bourguignon","blanquette","tajine","ragoût","bœuf carottes","mafé","colombo","pot-au-feu","navarin"]
   - "soupe" -> ["soupe","velouté","minestrone","bouillon"]
   - "gratin" -> ["gratin","tartiflette","parmentier","lasagne"]
   - "salade" -> ["salade","taboulé","ceviche"]
   - "wok / sauté" -> ["wok","sauté","poêlée","stir-fry"]
   Mets ces mots dans le champ "include" (préférence douce qui orientera le ranking) ou dans "specific.keyword" si un nombre est demandé. NE renvoie JAMAIS un terme générique comme "mijoté" tout seul, il ne matche rien.

Exemples :
"sans poisson cette semaine" -> {"specific":[],"diet":[],"exclude_diet":["Avec poisson"],"include":[],"exclude":[],"meals":null,"persons":null}
"sans boeuf et de saison" -> {"specific":[],"diet":[],"exclude_diet":[],"include":[],"exclude":["boeuf"],"meals":null,"persons":null}
"sans viande" -> {"specific":[],"diet":[],"exclude_diet":["Avec viande"],"include":[],"exclude":[],"meals":null,"persons":null}
"on aime les pâtes et le riz, pas de champignons" -> {"specific":[],"diet":[],"exclude_diet":[],"include":["pâte","riz"],"exclude":["champignon"],"meals":null,"persons":null}
"je veux 1 quiche et 4 autres plats" -> {"specific":[{"keyword":"quiche","count":1}],"diet":[],"exclude_diet":[],"include":[],"exclude":[],"meals":5,"persons":null}
"2 plats avec du poulet et 3 plats variés sans poisson" -> {"specific":[{"keyword":"poulet","count":2}],"diet":[],"exclude_diet":["Avec poisson"],"include":[],"exclude":[],"meals":5,"persons":null}
"7 repas pour 5 personnes, végétarien" -> {"specific":[],"diet":["Végétarien"],"exclude_diet":[],"include":[],"exclude":[],"meals":7,"persons":5}
"des plats mijotés" -> {"specific":[],"must_contain":[],"diet":[],"exclude_diet":[],"include":["bourguignon","blanquette","tajine","ragoût","bœuf carottes","mafé","colombo","pot-au-feu","navarin"],"exclude":[],"meals":null,"persons":null}
"1 soupe et 4 autres plats" -> {"specific":[{"keyword":"soupe velouté minestrone bouillon","count":1}],"must_contain":[],"diet":[],"exclude_diet":[],"include":[],"exclude":[],"meals":5,"persons":null}
"sans poisson, sans aubergine, un plat avec du riz, un plat avec des pâtes, un plat avec des pommes de terre, une quiche, intègre au moins 1 fois du poulet, 1 fois de la dinde, 1 fois de la viande hachée" -> {"specific":[{"keyword":"riz","count":1},{"keyword":"pâte","count":1},{"keyword":"pomme de terre","count":1},{"keyword":"quiche","count":1}],"must_contain":[{"keyword":"poulet","count":1},{"keyword":"dinde","count":1},{"keyword":"viande hachée","count":1}],"diet":[],"exclude_diet":["Avec poisson"],"include":[],"exclude":["aubergine"],"meals":null,"persons":null}`;

const SEASON_WORDS = /^(saison|saisonni[eè]re?|de saison|saisonnier)$/i;

function sanitizeFilters(f) {
  if (!f) return f;
  const cleanList = (arr) => (arr || []).filter(k => !SEASON_WORDS.test((k || '').trim()));
  const cleanCountedList = (arr) => (arr || []).filter(s => !SEASON_WORDS.test((s.keyword || '').trim()));
  return {
    ...f,
    include: cleanList(f.include),
    exclude: cleanList(f.exclude),
    specific: cleanCountedList(f.specific),
    must_contain: cleanCountedList(f.must_contain)
  };
}

async function parsePrecisions(text) {
  // Calls the server-side proxy at /api/anthropic/messages.
  // The server injects the API key from its ANTHROPIC_API_KEY env var,
  // so the key never lives in the browser.
  const res = await fetch(ANTHROPIC_PROXY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: text }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data.content[0].text;
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  return sanitizeFilters(JSON.parse(cleaned));
}

function recipeHaystack(r) {
  return [
    (r.title_name || '').toLowerCase(),
    ...(r.ingredients || []).map(i => i.toLowerCase())
  ].join(' | ');
}

function recipeContains(recipe, keyword) {
  if (!keyword) return false;
  return recipeHaystack(recipe).includes(keyword.toLowerCase());
}

// How many of the `mustContain` constraints are STILL not satisfied — and
// how many of those THIS recipe would knock off the list.
function satisfactionScore(recipe, mustContain, satCounts) {
  let score = 0;
  for (const mc of mustContain) {
    const need = mc.count || 1;
    const have = satCounts[mc.keyword] || 0;
    if (have < need && recipeContains(recipe, mc.keyword)) score++;
  }
  return score;
}

function updateSatisfaction(recipe, mustContain, satCounts) {
  for (const mc of mustContain) {
    if (recipeContains(recipe, mc.keyword)) {
      satCounts[mc.keyword] = (satCounts[mc.keyword] || 0) + 1;
    }
  }
}

function unmetMustContain(mustContain, satCounts) {
  return mustContain.filter(mc => (satCounts[mc.keyword] || 0) < (mc.count || 1));
}

function applyExcludeKeywords(recipes, exclude) {
  if (!exclude || exclude.length === 0) return recipes;
  const patterns = exclude.map(k => k.toLowerCase());
  return recipes.filter(r => !patterns.some(p => recipeHaystack(r).includes(p)));
}

// Keep recipes that contain AT LEAST ONE of the keywords in title/ingredients.
// Falls back to the full pool when nothing matches strongly enough.
function filterAnyMatch(recipes, keywords, minimumDesired) {
  if (!keywords || keywords.length === 0) return recipes;
  const norms = keywords.map(k => k.toLowerCase()).filter(Boolean);
  if (norms.length === 0) return recipes;
  const matched = recipes.filter(r => {
    const hay = recipeHaystack(r);
    return norms.some(k => hay.includes(k));
  });
  if (matched.length >= minimumDesired) return matched;
  // Not enough strict matches — broaden gracefully but still prefer matched first.
  const matchedSet = new Set(matched.map(r => r.objectID));
  const others = recipes.filter(r => !matchedSet.has(r.objectID));
  return [...matched, ...others];
}

// ===== Speech recognition =====

let recognition = null;

function initSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('mic-btn');
  const status = document.getElementById('speech-status');
  const textarea = document.getElementById('precisions');

  if (!SR) {
    micBtn.disabled = true;
    micBtn.title = 'Reconnaissance vocale non supportée par ce navigateur';
    micBtn.style.opacity = .4;
    return;
  }

  micBtn.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = 'fr-FR';
    recognition.continuous = false;
    recognition.interimResults = true;

    let finalText = '';
    micBtn.classList.add('recording');
    status.classList.remove('error');
    status.textContent = '🎙️ J\'écoute...';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interim += t;
      }
      textarea.value = (finalText + interim).trim();
    };

    recognition.onerror = (e) => {
      status.classList.add('error');
      status.textContent = `Erreur micro : ${e.error}`;
    };

    recognition.onend = () => {
      micBtn.classList.remove('recording');
      if (!status.classList.contains('error')) status.textContent = '';
      recognition = null;
    };

    recognition.start();
  });
}

// ===== Main flow =====

const appState = {
  items: [],            // { recipe, protein, source: 'specific'|'variety', keyword? }
  context: {},          // { season, diet, excludeDiet, excludeKeywords, includeKeywords }
  skippedIds: new Set() // recipes the user already swapped away from this session
};

function pickImage(recipe, audience) {
  if (audience === 'family' && typeof recipe.family_image === 'string' && recipe.family_image.trim()) {
    return recipe.family_image;
  }
  return recipe.image_url || null;
}

function cardHtml(item, index) {
  const r = item.recipe;
  const protein = item.protein;
  const express = isExpress(r);
  const img = pickImage(r, appState.context.audience);
  return `
    <div class="recipe-card" data-index="${index}">
      <button type="button" class="swap-btn" title="Changer cette recette" aria-label="Changer cette recette">🔄</button>
      <a href="${r.url}" target="_blank" rel="noopener" class="recipe-link">
        ${img
          ? `<img src="${img}" alt="" loading="lazy">`
          : `<div class="no-img">🍽️</div>`}
        <div class="recipe-info">
          <h4>${decodeHtml(r.title_name)}</h4>
          <div class="tags">
            <span class="tag tag-${protein}">${proteinLabel(protein)}</span>
            ${express ? `<span class="tag tag-express">⏱ Express</span>` : ''}
          </div>
        </div>
      </a>
    </div>`;
}

function renderMenu(items, persons, season, appliedFilters) {
  const results = document.getElementById('results');
  let html = '';

  if (appliedFilters) html += renderAppliedFilters(appliedFilters);

  html += `<section class="menu">
    <div class="menu-header">
      <h2>${items.length} recette${items.length > 1 ? 's' : ''} pour ${persons} personne${persons > 1 ? 's' : ''}</h2>
      <span class="season-badge">🌿 ${season}</span>
    </div>
    <div class="meals">`;

  items.forEach((item, i) => { html += cardHtml(item, i); });

  html += `</div></section>`;
  results.innerHTML = html;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function swapRecipe(index) {
  const item = appState.items[index];
  const ctx = appState.context;
  if (!item) return;

  const card = document.querySelector(`.recipe-card[data-index="${index}"]`);
  if (card) card.classList.add('swapping');

  const usedIds = new Set(appState.items.map(i => i.recipe.objectID));

  try {
    // Build the candidate pool of recipes that match the same constraints
    // as the recipe currently in this slot.
    let candidates;
    if (item.source === 'specific') {
      const tokens = (item.keyword || '').split(/\s+/).filter(Boolean);
      const hits = await searchRecipes({
        season: ctx.season,
        audience: ctx.audience,
        ageBucket: ctx.ageBucket,
        diet: ctx.diet,
        excludeDiet: ctx.excludeDiet,
        query: item.keyword,
        optionalWords: tokens.length > 1 ? tokens : [],
        hitsPerPage: 50
      });
      candidates = applyExcludeKeywords(hits, ctx.excludeKeywords);
    } else {
      const hits = await searchRecipes({
        season: ctx.season,
        audience: ctx.audience,
        ageBucket: ctx.ageBucket,
        diet: ctx.diet,
        excludeDiet: ctx.excludeDiet,
        query: (ctx.includeKeywords || []).join(' '),
        optionalWords: ctx.includeKeywords || [],
        hitsPerPage: 500
      });
      let filtered = applyExcludeKeywords(hits, ctx.excludeKeywords);
      if ((ctx.includeKeywords || []).length > 0) {
        filtered = filterAnyMatch(filtered, ctx.includeKeywords, 8);
      }
      candidates = filtered.filter(r => proteinCategory(r) === item.protein);
      // Fallback: if no recipe of same protein, allow any protein
      if (candidates.length === 0) candidates = filtered;
    }

    // Step 1: try only recipes never displayed AND never skipped this session.
    let pool = candidates.filter(r => !usedIds.has(r.objectID) && !appState.skippedIds.has(r.objectID));

    // Step 2: if exhausted, the user has cycled through the whole catalogue
    // for this slot — reset the skipped memory so we can re-suggest them.
    if (pool.length === 0) {
      appState.skippedIds.clear();
      pool = candidates.filter(r => !usedIds.has(r.objectID));
    }

    if (pool.length === 0) {
      if (card) {
        card.classList.remove('swapping');
        card.classList.add('swap-error');
        setTimeout(() => card.classList.remove('swap-error'), 1500);
      }
      return;
    }

    const next = shuffle(pool)[0];
    // Remember the recipe we're skipping away from so we don't re-suggest it
    // until the candidate pool is exhausted.
    appState.skippedIds.add(item.recipe.objectID);

    appState.items[index] = {
      ...item,
      recipe: next,
      protein: proteinCategory(next)
    };
    if (card) card.outerHTML = cardHtml(appState.items[index], index);
  } catch (err) {
    console.error(err);
    if (card) card.classList.remove('swapping');
  }
}

function renderAppliedFilters(f) {
  const chips = [];
  for (const s of f.specific || []) chips.push(`<span class="chip">${s.count}× ${s.keyword}</span>`);
  for (const d of f.diet || []) chips.push(`<span class="chip">${d}</span>`);
  for (const d of f.exclude_diet || []) chips.push(`<span class="chip exclude">sans ${d.replace(/^Avec /, '')}</span>`);
  for (const k of f.include || []) chips.push(`<span class="chip">+ ${k}</span>`);
  for (const k of f.exclude || []) chips.push(`<span class="chip exclude">− ${k}</span>`);
  if (chips.length === 0) return '';
  return `<div class="applied-filters"><strong>Précisions appliquées :</strong> ${chips.join(' ')}</div>`;
}

function monthsBetween(from, to) {
  let m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) m -= 1;
  return m;
}

function bucketFromMonths(months) {
  if (months < 4) return null;
  if (months < 6) return '4 à 6 mois';
  if (months < 9) return '6 à 8 mois';
  if (months < 12) return '9 à 12 mois';
  return '12 mois et +';
}

function getBabyAgeBucket() {
  const v = document.getElementById('baby-birthdate').value;
  if (!v) return { months: null, bucket: null };
  const months = monthsBetween(new Date(v), new Date());
  return { months, bucket: bucketFromMonths(months) };
}

async function generate() {
  let meals = +document.getElementById('meals').value;
  let persons = +document.getElementById('persons').value;
  const baseDiet = [...document.querySelectorAll('input[name=diet]:checked')].map(i => i.value);
  const precisions = document.getElementById('precisions').value.trim();
  const audience = document.querySelector('input[name=audience]:checked').value;

  const season = getCurrentSeason();
  const results = document.getElementById('results');
  const btn = document.getElementById('submit-btn');

  let ageBucket = null;
  if (audience === 'baby' || audience === 'family-baby') {
    const birthdate = document.getElementById('baby-birthdate').value;
    if (!birthdate) {
      results.innerHTML = `<div class="error">Indiquez la date de naissance du bébé pour ce mode.</div>`;
      return;
    }
    localStorage.setItem('baby_birthdate', birthdate);
    const { months, bucket } = getBabyAgeBucket();
    if (audience === 'baby' && !bucket) {
      results.innerHTML = `<div class="error">Le bébé est trop jeune (${months < 0 ? 'pas encore né' : months + ' mois'}). La diversification commence vers 4 mois.</div>`;
      return;
    }
    if (audience === 'family-baby' && months < 6) {
      results.innerHTML = `<div class="error">Les recettes Parents-bébé sont conçues pour bébés à partir de ~6 mois. Choisissez "Bébé seul" pour les ${months} mois.</div>`;
      return;
    }
    ageBucket = bucket;
  }

  btn.disabled = true;

  try {
    let llmFilters = null;

    if (precisions) {
      results.innerHTML = `<p class="loading">🧠 Analyse de vos précisions...</p>`;
      try {
        llmFilters = await parsePrecisions(precisions);
      } catch (err) {
        results.innerHTML = `<div class="error">Impossible d'analyser les précisions : ${err.message}</div>`;
        return;
      }
      // Never let the LLM shrink meals below what the user typed in the form,
      // and ensure we have enough room for all specifics.
      const specificsSum = (llmFilters.specific || []).reduce((s, x) => s + (x.count || 0), 0);
      if (llmFilters.meals) meals = Math.max(meals, llmFilters.meals);
      meals = Math.max(meals, specificsSum);
      if (llmFilters.persons) persons = llmFilters.persons;
    }

    results.innerHTML = `<p class="loading">⏳ On mijote votre menu de ${season.toLowerCase()}...</p>`;

    const diet = [...baseDiet, ...((llmFilters && llmFilters.diet) || [])];
    const excludeDiet = (llmFilters && llmFilters.exclude_diet) || [];
    const includeKeywords = (llmFilters && llmFilters.include) || [];
    const excludeKeywords = (llmFilters && llmFilters.exclude) || [];
    const specifics = (llmFilters && llmFilters.specific) || [];
    const mustContain = (llmFilters && llmFilters.must_contain) || [];
    const mustContainKeywords = mustContain.map(mc => mc.keyword).filter(Boolean);

    const usedIds = new Set();
    const satCounts = {}; // tracking must_contain satisfaction across all picks
    const specificPicks = []; // { recipe, keyword }

    // Step 1: fulfill specific requests (e.g. "1 quiche"). For each specific,
    // pick the candidate that also covers the MOST unsatisfied must_contain
    // constraints so a single dish can serve multiple wishes.
    for (const s of specifics) {
      const tokens = (s.keyword || '').split(/\s+/).filter(Boolean);
      const optWords = [...new Set([...(tokens.length > 1 ? tokens : []), ...mustContainKeywords])];
      const hits = await searchRecipes({
        season,
        audience,
        ageBucket,
        diet,
        excludeDiet,
        query: s.keyword,
        optionalWords: optWords,
        hitsPerPage: 50
      });
      let filtered = applyExcludeKeywords(hits, excludeKeywords)
        .filter(r => !usedIds.has(r.objectID));
      // Keep recipes that strictly match the specific keyword in title/ingredients.
      const strict = filtered.filter(r => recipeContains(r, s.keyword));
      if (strict.length >= s.count) filtered = strict;

      // Sort by must_contain satisfaction (desc), keep some randomness within ties
      const scored = filtered.map(r => ({ r, score: satisfactionScore(r, mustContain, satCounts), rand: Math.random() }));
      scored.sort((a, b) => b.score - a.score || a.rand - b.rand);

      const picks = scored.slice(0, s.count).map(x => x.r);
      if (picks.length < s.count) {
        results.innerHTML = `<div class="error">Pas assez de recettes "${s.keyword}" trouvées (${picks.length}/${s.count}). Assouplissez les autres contraintes.</div>`;
        return;
      }
      for (const r of picks) {
        specificPicks.push({ recipe: r, keyword: s.keyword });
        usedIds.add(r.objectID);
        updateSatisfaction(r, mustContain, satCounts);
      }
    }

    const remaining = meals - specificPicks.length;
    let varietyPicks = [];

    // Step 2: fill the rest. Two passes — first pick recipes that resolve any
    // still-unmet must_contain, then balanced variety for the leftover slots.
    if (remaining > 0) {
      const unmet = unmetMustContain(mustContain, satCounts);
      const unmetKeywords = unmet.map(mc => mc.keyword);
      let pool = await searchRecipes({
        season,
        audience,
        ageBucket,
        diet,
        excludeDiet,
        query: [...includeKeywords, ...unmetKeywords].join(' '),
        optionalWords: [...includeKeywords, ...unmetKeywords],
        hitsPerPage: 500
      });

      pool = applyExcludeKeywords(pool, excludeKeywords)
        .filter(r => !usedIds.has(r.objectID));

      if (includeKeywords.length > 0) {
        pool = filterAnyMatch(pool, includeKeywords, remaining);
      }

      if (pool.length < remaining) {
        results.innerHTML = `<div class="error">Seulement ${pool.length + specificPicks.length} recette${pool.length + specificPicks.length > 1 ? 's' : ''} disponible${pool.length + specificPicks.length > 1 ? 's' : ''}. Réduisez le nombre de repas ou assouplissez vos précisions.</div>`;
        return;
      }

      // 2a. Force-pick recipes that satisfy unmet must_contain constraints.
      const forced = [];
      for (const mc of unmet) {
        if ((satCounts[mc.keyword] || 0) >= (mc.count || 1)) continue;
        const candidates = pool
          .filter(r => !usedIds.has(r.objectID) && recipeContains(r, mc.keyword))
          .map(r => ({ r, score: satisfactionScore(r, mustContain, satCounts), rand: Math.random() }))
          .sort((a, b) => b.score - a.score || a.rand - b.rand);
        const need = (mc.count || 1) - (satCounts[mc.keyword] || 0);
        for (let i = 0; i < need && i < candidates.length && forced.length < remaining; i++) {
          const r = candidates[i].r;
          forced.push(r);
          usedIds.add(r.objectID);
          updateSatisfaction(r, mustContain, satCounts);
        }
        if (forced.length >= remaining) break;
      }

      // 2b. Fill leftover slots with balanced selection from the rest.
      const leftover = remaining - forced.length;
      let balanced = [];
      if (leftover > 0) {
        const rest = pool.filter(r => !usedIds.has(r.objectID));
        balanced = pickBalanced(rest, leftover);
      }
      varietyPicks = [...forced, ...balanced];
    }

    const items = [
      ...specificPicks.map(({ recipe, keyword }) => ({
        recipe,
        protein: proteinCategory(recipe),
        source: 'specific',
        keyword
      })),
      ...varietyPicks.map(r => ({
        recipe: r,
        protein: proteinCategory(r),
        source: 'variety'
      }))
    ];

    if (items.length === 0) {
      results.innerHTML = `<div class="error">Aucune recette trouvée avec ces critères.</div>`;
      return;
    }

    const shuffled = shuffle(items);

    appState.items = shuffled;
    appState.context = { season, audience, ageBucket, diet, excludeDiet, excludeKeywords, includeKeywords };
    // Fresh menu = fresh skip memory.
    appState.skippedIds = new Set();

    renderMenu(shuffled, persons, season, llmFilters);
  } catch (err) {
    console.error(err);
    results.innerHTML = `<div class="error">Erreur : ${err.message}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ===== Init =====

function updateBabyBlock() {
  const audience = document.querySelector('input[name=audience]:checked').value;
  const block = document.getElementById('baby-birthdate-block');
  block.hidden = audience === 'family';
  updateBabyAgeInfo();
}

function updateBabyAgeInfo() {
  const info = document.getElementById('baby-age-info');
  const audience = document.querySelector('input[name=audience]:checked').value;
  const v = document.getElementById('baby-birthdate').value;
  if (!v) { info.textContent = ''; info.classList.remove('warn'); return; }
  const months = monthsBetween(new Date(v), new Date());
  const bucket = bucketFromMonths(months);
  let txt = `Bébé : ${months} mois`;
  if (bucket) txt += ` → tranche « ${bucket} »`;
  info.textContent = txt;
  info.classList.remove('warn');
  if (audience === 'baby' && !bucket) {
    info.textContent += ' — trop jeune pour la diversification';
    info.classList.add('warn');
  } else if (audience === 'family-baby' && months < 6) {
    info.textContent += ' — Parents-bébé démarre à ~6 mois';
    info.classList.add('warn');
  }
}

// ===== Saved precision presets =====

const PRESETS_KEY = 'menu_gen_precisions_presets_v1';

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function savePresets(presets) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

function renderPresets() {
  const container = document.getElementById('preset-chips');
  if (!container) return;
  const presets = loadPresets();
  container.innerHTML = presets.map((p, i) => `
    <span class="preset-chip" data-index="${i}" title="${escapeAttr(p.text)}">
      <span class="preset-chip-name">${escapeHtml(p.name)}</span>
      <button type="button" class="preset-del" data-index="${i}" title="Supprimer ce préréglage" aria-label="Supprimer">✕</button>
    </span>
  `).join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function onPresetSave() {
  const textarea = document.getElementById('precisions');
  const text = textarea.value.trim();
  if (!text) {
    alert('Écris d\'abord tes précisions dans la zone de texte.');
    return;
  }
  const name = prompt('Nom du préréglage :', text.slice(0, 30));
  if (!name) return;
  const presets = loadPresets();
  // Replace if same name exists
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name: name.trim(), text };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  renderPresets();
}

function onPresetClick(e) {
  const del = e.target.closest('.preset-del');
  if (del) {
    e.stopPropagation();
    const idx = +del.dataset.index;
    const presets = loadPresets();
    if (confirm(`Supprimer le préréglage "${presets[idx]?.name}" ?`)) {
      presets.splice(idx, 1);
      savePresets(presets);
      renderPresets();
    }
    return;
  }
  const chip = e.target.closest('.preset-chip');
  if (!chip) return;
  const idx = +chip.dataset.index;
  const presets = loadPresets();
  const p = presets[idx];
  if (!p) return;
  document.getElementById('precisions').value = p.text;
}

document.addEventListener('DOMContentLoaded', () => {
  const birthdate = localStorage.getItem('baby_birthdate');
  if (birthdate) document.getElementById('baby-birthdate').value = birthdate;

  document.querySelectorAll('input[name=audience]').forEach(r => {
    r.addEventListener('change', updateBabyBlock);
  });
  document.getElementById('baby-birthdate').addEventListener('change', updateBabyAgeInfo);
  updateBabyBlock();

  document.getElementById('preset-save-btn').addEventListener('click', onPresetSave);
  document.getElementById('preset-chips').addEventListener('click', onPresetClick);
  renderPresets();

  initSpeech();
});

document.getElementById('generator-form').addEventListener('submit', e => {
  e.preventDefault();
  generate();
});

document.getElementById('results').addEventListener('click', e => {
  const btn = e.target.closest('.swap-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const card = btn.closest('.recipe-card[data-index]');
  if (!card) return;
  swapRecipe(+card.dataset.index);
});
