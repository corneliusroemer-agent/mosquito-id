/* Species KB renderer — prototype.
 *
 * One page, one JSON file, for all species. Adding a species is a new object in
 * species-data.json (plus its SPECIES_META entry in main.js so the app can
 * classify to it) — there is no per-species file to generate and no step to run
 * before the site is live.
 */
(function () {
  "use strict";

  // The classifier collapses several names onto one label (SPECIES_CANONICAL),
  // so accept either the slug or the scientific name.
  function requestedKey() {
    var q = new URLSearchParams(location.search);
    return q.get("s") || location.hash.replace(/^#/, "") || "";
  }

  function slugify(name) {
    return name.toLowerCase().replace(/\s+/g, "-");
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

  function render(sp, all) {
    var h = [];
    h.push('<div class="kb-eyebrow">' + esc(sp.genus) + "</div>");
    h.push('<h1 class="kb-title">' + esc(sp.name) + "</h1>");
    h.push('<p class="kb-common">' + esc(sp.common) + "</p>");
    if (sp.blurb) h.push('<p class="kb-lead">' + esc(sp.blurb) + "</p>");

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
        h.push('<a href="species.html?s=' + esc(x.slug) + '"><b>' + esc(x.name) + "</b> <span>" + esc(x.common) + "</span></a>");
      });
      h.push("</div>");
    }
    return h.join("\n");
  }

  function show(html, docTitle) {
    document.getElementById("kb-body").innerHTML = html;
    document.title = docTitle;
  }

  fetch("species-data.json")
    .then(function (r) {
      if (!r.ok) throw new Error("species-data.json " + r.status);
      return r.json();
    })
    .then(function (doc) {
      var all = doc.species;
      var key = requestedKey();
      var sp = all.filter(function (x) { return x.slug === key || x.name === key; })[0];
      if (!sp) {
        var list = all.map(function (x) { return '<a href="species.html?s=' + esc(x.slug) + '">' + esc(x.name) + "</a>"; }).join(", ");
        show('<h1 class="kb-title">Species guide</h1><p class="kb-lead">' + all.length +
             " species have a page here. Pick one:</p><p>" + list + "</p>", "Species guide · Mosquito ID");
        return;
      }
      show(render(sp, all), sp.name + " (" + sp.common + ") · Mosquito ID");
    })
    .catch(function (err) {
      show('<h1 class="kb-title">Species guide</h1><p class="kb-lead kb-error">Could not load ' +
           "species-data.json (" + esc(err.message) + ").</p>",
           "Species guide · Mosquito ID");
    });
})();
