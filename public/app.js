// Quote cards: draws a 1080×1080 image of a chosen line with the book title, for sharing.
(function () {
  var box = document.querySelector('[data-quote-cards]');
  if (box) {
    var preview = box.querySelector('[data-preview]');
    var img = box.querySelector('[data-preview-img]');
    var dl = box.querySelector('[data-download]');
    var shareBtn = box.querySelector('[data-share]');
    var title = box.getAttribute('data-title');
    var author = box.getAttribute('data-author');
    var chapter = box.getAttribute('data-chapter');
    var currentBlob = null;

    function wrapLines(ctx, text, maxWidth) {
      var words = text.split(/\s+/), lines = [], line = '';
      words.forEach(function (w) {
        var test = line ? line + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
      });
      if (line) lines.push(line);
      return lines;
    }
    function draw(quote) {
      var S = 1080, c = document.createElement('canvas');
      c.width = S; c.height = S;
      var ctx = c.getContext('2d');
      var g = ctx.createLinearGradient(0, 0, S, S); g.addColorStop(0, '#2C2D26'); g.addColorStop(1, '#1B1C17');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = 'rgba(209,174,104,0.75)'; ctx.lineWidth = 3; ctx.strokeRect(54, 54, S - 108, S - 108);
      ctx.strokeStyle = 'rgba(209,174,104,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(68, 68, S - 136, S - 136);
      ctx.fillStyle = '#D1AE68'; ctx.font = '600 220px Fraunces, Georgia, serif'; ctx.fillText('“', 110, 300);
      var size = quote.length > 220 ? 46 : quote.length > 140 ? 54 : quote.length > 80 ? 62 : 72;
      ctx.font = 'italic 400 ' + size + 'px Fraunces, Georgia, serif';
      ctx.fillStyle = '#F3ECDC';
      var lines = wrapLines(ctx, quote, S - 260);
      var lh = size * 1.32, top = (S - lines.length * lh) / 2 + size * 0.4;
      lines.forEach(function (l, i) { ctx.fillText(l, 130, top + i * lh); });
      ctx.fillStyle = '#D1AE68';
      ctx.font = '600 36px Cinzel, Georgia, serif';
      ctx.fillText(title.toUpperCase(), 130, S - 200);
      ctx.fillStyle = '#CFC8B6';
      ctx.font = '400 28px Inter, system-ui, sans-serif';
      var foot = author + ' · ' + chapter; if (foot.length > 62) foot = foot.slice(0, 60) + '…';
      ctx.fillText(foot, 130, S - 150);
      ctx.fillStyle = '#8F8A7A'; ctx.font = '500 24px Inter, system-ui, sans-serif';
      ctx.fillText(location.host, 130, S - 108);
      return c;
    }
    box.querySelectorAll('[data-make-card]').forEach(function (b) {
      b.addEventListener('click', function () {
        var quote = b.getAttribute('data-make-card');
        (document.fonts ? Promise.all([document.fonts.load('italic 400 60px Fraunces'), document.fonts.load('600 36px Cinzel'), document.fonts.load('400 28px Inter')]).catch(function () {}) : Promise.resolve()).then(function () {
          var c = draw(quote);
          c.toBlob(function (blob) {
            currentBlob = blob;
            var url = URL.createObjectURL(blob);
            img.src = url; dl.href = url;
            preview.style.display = 'block';
            var file = new File([blob], 'quote-card.png', { type: 'image/png' });
            shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
            preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 'image/png');
        });
      });
    });
    shareBtn.addEventListener('click', function () {
      if (!currentBlob) return;
      var file = new File([currentBlob], 'quote-card.png', { type: 'image/png' });
      navigator.share({ files: [file], title: title, text: title + ' by ' + author + ' ' + location.origin }).catch(function () {});
    });
  }

  // Confirm dialogs for destructive actions (CSP-safe, no inline JS)
  document.addEventListener('submit', function (e) {
    var msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
})();

// Donation amount chips fill the amount box
(function () {
  var form = document.querySelector('[data-donate]');
  if (!form) return;
  var amount = form.querySelector('#amount');
  form.querySelectorAll('input[name="preset"]').forEach(function (r) {
    r.addEventListener('change', function () {
      if (r.value === 'other') { amount.value = ''; amount.focus(); } else amount.value = r.value;
    });
  });
  amount.addEventListener('input', function () {
    var match = form.querySelector('input[name="preset"][value="' + amount.value.replace(/[^0-9]/g, '') + '"]');
    (match || form.querySelector('#amt-other')).checked = true;
  });
})();

// Copy bank details
document.querySelectorAll('[data-copy]').forEach(function (b) {
  b.addEventListener('click', function () {
    var text = b.getAttribute('data-copy');
    var done = function () { var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    else { var i = document.createElement('input'); i.value = text; document.body.appendChild(i); i.select(); try { document.execCommand('copy'); done(); } catch (e) {} i.remove(); }
  });
});

// Reading progress bar
(function () {
  var bar = document.querySelector('[data-progress]'), text = document.querySelector('[data-reading]');
  if (!bar || !text) return;
  var tick = function () {
    var r = text.getBoundingClientRect(), total = r.height - window.innerHeight * 0.6;
    var p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0;
    bar.style.width = (p * 100).toFixed(1) + '%';
  };
  window.addEventListener('scroll', tick, { passive: true }); tick();
})();
