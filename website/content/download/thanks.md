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

If it didn't work, <a id="download-fallback-link" href="{{< param "repo" >}}/releases/tag/v{{< param "version" >}}">grab it from the releases page</a>.

---

Check out the [quickstart guide](/docs/quickstart/) to get up and running.

</div>

<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var to = params.get('to');
  if (!to || to === '#') return;

  // Only kick off the download. The fallback link deliberately keeps pointing at
  // the releases page: if this URL failed, offering the same one again is no help.
  window.location.href = to;
})();
</script>
