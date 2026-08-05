---
title: Thanks for downloading
toc: false
sitemap:
  disable: true
sidebar:
  exclude: true
---

<div class="hx-text-center">

Thanks for downloading `js65`! Your download should start automatically.

If it didn't work, <a id="download-fallback-link" href="{{< relref "/download/" >}}">try this link</a>.

---

Check out the [quickstart guide](/docs/quickstart/) to get up and running.

</div>

<script>
(function () {
  var fallback = document.getElementById('download-fallback-link');
  if (!fallback) return;

  var params = new URLSearchParams(window.location.search);
  var to = params.get('to');
  if (!to || to === '#') return;

  fallback.setAttribute('href', to);
  window.location.href = to;
})();
</script>
