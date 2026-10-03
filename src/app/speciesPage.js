/* Species guide renderer.
 *
 * A route of the classifier shell (#/species/<slug>), not a page of its own:
 * the app's router calls render(slug), and the container it writes into is
 * hidden or shown rather than torn down. Keeping the classifier DOM
 * alive across a navigation is what preserves the photo, the crop and the
 * scores - nothing here reads or restores app state.
 *
 * One JSON file, one renderer, all species. Adding a species is a new object in
 * species-data.json (plus its SPECIES_META entry in main.js so the app can
 * classify to it) - there is no per-species file to generate and no step to run
 * before the site is live.
 */

// species-data.json is a static file that never changes without a deploy, so
// the fetch is made once per page load and shared by every later navigation.
// Re-fetching per route change would make each back-and-forth slower than
// loading the KB as its own page in the first place.
var docPromise = null;
function loadDoc() {
  if (!docPromise) {
    docPromise = fetch("species-data.json")
      .then(function (r) {
        if (!r.ok) throw new Error("species-data.json " + r.status);
        return r.json();
      })
      .catch(function (err) {
        docPromise = null; // let a later navigation retry a transient failure
        throw err;
      });
  }
  return docPromise;
}

// Reference photographs live in the same R2 bucket that serves the model
// weights, under an images/ prefix, so adding a picture costs the git
// history nothing and the site picks it up on the next deploy with no build
// step. Only the path is stored per species; the host is one constant here.
var IMAGE_BASE_URL =
  "https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/images/";

// In-app route for a species. A bare fragment href needs no click handler:
// the browser sets location.hash and the router's hashchange listener runs.
function link(slug) {
  return "#/species/" + slug;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function vectorClass(v) {
  return /not a significant|potential/i.test(v) ? " none" : "";
}

function fact(label, value, cls) {
  if (!value) return "";
  return "<dt>" + esc(label) + "</dt><dd" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(value) + "</dd>";
}

/* One photograph with its caption and its credits.
 *
 * CC BY and CC BY-SA both oblige us to name the author, the licence and the
 * source whenever we show the picture, so all three are rendered here rather
 * than collected on a separate credits page nobody opens. The attribution is
 * part of the figure, which is also where the licence's own terms are most
 * usefully encountered - a reader who wants to know what they may do with a
 * picture is looking at the picture.
 */
function shot(sp, im, i) {
  var src = im.src && im.src.charAt(0) === "/" ? im.src : IMAGE_BASE_URL + im.src;
  var h = [];
  h.push('<figure class="kb-shot">');
  // width/height are stored so the browser reserves the box before the bytes
  // arrive: a gallery that reflows as it loads is visible jank on a phone.
  h.push('<img src="' + esc(src) + '" alt="' + esc(im.alt || (sp.name + " reference photograph")) +
         '" loading="lazy" decoding="async"' +
         (im.w ? ' width="' + (im.w | 0) + '"' : "") +
         (im.h ? ' height="' + (im.h | 0) + '"' : "") + ">");
  h.push("<figcaption>");
  // Sex first and on its own line: whether a photo is male or female is the
  // first thing a reader checks, and the two look different in every one of
  // these species. Omitted rather than guessed when the source did not say.
  if (im.sex) h.push('<span class="kb-sex">' + esc(im.sex) + "</span>");
  if (im.caption) h.push(esc(im.caption) + (im.sex ? " " : ""));
  h.push('<span class="kb-credit">');
  var bits = [];
  if (im.author) bits.push(esc(im.author));
  // species-data.json spells these keys snake_case, like every other field in
  // it. Reading them camelCase silently dropped the licence and source links
  // from all 40 photo captions, which for CC BY work means shipping the
  // photographs with their attribution requirement unmet.
  var licenceUrl = im.licence_url || im.licenceUrl;
  var sourceUrl = im.source_url || im.sourceUrl;
  if (im.licence) {
    bits.push(licenceUrl
      ? '<a href="' + esc(licenceUrl) + '" target="_blank" rel="noopener nofollow">' + esc(im.licence) + "</a>"
      : esc(im.licence));
  }
  if (sourceUrl) {
    bits.push('<a href="' + esc(sourceUrl) + '" target="_blank" rel="noopener nofollow">source</a>');
  }
  if (bits.length) h.push("&middot; " + bits.join(" &middot; "));
  h.push("</span></figcaption></figure>");
  return h.join("");
}

/* The gallery, or nothing at all.
 *
 * A species with no verified photograph is a normal state, not an error:
 * several of the sixteen are common enough that Commons has no usable
 * picture of, and a caption saying so would be worse than the absence. The
 * section is simply not emitted, so the page reads exactly as it did before
 * photographs existed. */
function gallery(sp) {
  var ims = (sp.images || []).filter(function (im) { return im && im.src; });
  if (!ims.length) return "";
  var h = ['<h2 class="kb-h">What it looks like</h2><div class="kb-gallery">'];
  ims.forEach(function (im, i) { h.push(shot(sp, im, i)); });
  h.push("</div>");
  h.push('<p class="kb-gallery-note">Reference photographs of identified museum and ' +
         "field specimens. Sex matters: females need a blood meal to develop " +
         "eggs and are the ones that bite.</p>");
  return h.join("\n");
}

function render(sp, all) {
  var h = [];
  h.push('<div class="kb-eyebrow">' + esc(sp.genus) + "</div>");
  h.push('<h1 class="kb-title">' + esc(sp.name) + "</h1>");
  h.push('<p class="kb-common">' + esc(sp.common) + "</p>");
  if (sp.blurb) h.push('<p class="kb-lead">' + esc(sp.blurb) + "</p>");

  // Photographs sit directly under the introduction, before the data block:
  // a reader who wants to know what the species looks like has not yet
  // started reading the species sheet, and this is the part they came for.
  h.push(gallery(sp));

  h.push('<h2 class="kb-h">At a glance</h2><dl class="kb-facts">');
  h.push(fact("Disease vector", sp.vectors, "kb-viz" + vectorClass(sp.vectors)));
  h.push(fact("Where it lives", sp.range));
  h.push(fact("When it bites", sp.activity));
  h.push(fact("Prefers to feed on", sp.hosts));
  h.push("</dl>");

  if (sp.distinguish) {
    h.push('<h2 class="kb-h">Telling it apart</h2><p class="kb-lead">' + esc(sp.distinguish) + "</p>");
  }
  if (sp.lookFor) {
    h.push('<h2 class="kb-h">Where to look for it</h2><p class="kb-lead">' + esc(sp.lookFor) + "</p>");
  }
  if (sp.notes) {
    h.push('<h2 class="kb-h">Notes</h2><p class="kb-notes">' + esc(sp.notes) + "</p>");
  }
  if (sp.local) {
    h.push('<h2 class="kb-h">Around Basel</h2><p class="kb-local">' + esc(sp.local) + "</p>");
  }

  h.push('<h2 class="kb-h">Read more</h2><p class="kb-links">');
  if (sp.wiki) h.push('<a href="' + esc(sp.wiki) + '" target="_blank" rel="noopener">' + esc(sp.name) + " on Wikipedia</a>");
  h.push("</p>");

  // Same-genus cross-links: what else the classifier might have called it.
  // Hand-picked seeAlso wins; otherwise fall back to same-genus, capped so
  // the section stays a couple of links rather than the whole genus.
  var names = (sp.seeAlso || []).length ? sp.seeAlso
    : all.filter(function (x) { return x.name !== sp.name && x.genus === sp.genus; })
         .map(function (x) { return x.name; });
  var seen = {};
  var links = names.slice(0, 4)
    .map(function (n) { return all.filter(function (x) { return x.name === n; })[0]; })
    .filter(function (x) { return x && !seen[x.name] && (seen[x.name] = 1); });
  if (links.length) {
    h.push('<h2 class="kb-h">Compare with</h2><div class="kb-more">');
    links.forEach(function (x) {
      h.push('<a href="' + link(esc(x.slug)) + '"><b>' + esc(x.name) + "</b> <span>" + esc(x.common) + "</span></a>");
    });
    h.push("</div>");
  }
  return h.join("\n");
}

function indexHtml(all) {
  var list = all.map(function (x) {
    return '<a href="' + link(esc(x.slug)) + '">' + esc(x.name) + "</a>";
  }).join(", ");
  return '<h1 class="kb-title">Species guide</h1><p class="kb-lead">' + all.length +
         " species have a page here. Pick one:</p><p>" + list + "</p>";
}

function show(container, html, docTitle) {
  container.innerHTML = html;
  document.title = docTitle;
}

/* key may be a slug or, because the classifier collapses several names onto
   one label (SPECIES_CANONICAL), the scientific name itself. An empty or
   unknown key renders the all-species index rather than a blank page. */
function render_(key, container) {
  var target = container || document.getElementById("kb-body");
  if (!target) return Promise.resolve();
  return loadDoc().then(function (doc) {
    var all = doc.species;
    var sp = all.filter(function (x) { return x.slug === key || x.name === key; })[0];
    if (!sp) {
      show(target, indexHtml(all), "Species guide · Mosquito ID");
      return;
    }
    show(target, render(sp, all), sp.name + " (" + sp.common + ") · Mosquito ID");
  }).catch(function (err) {
    show(target, '<h1 class="kb-title">Species guide</h1><p class="kb-lead kb-error">Could not load ' +
         "species-data.json (" + esc(err.message) + ").</p>",
         "Species guide · Mosquito ID");
  });
}

export { render_ as render, link };
