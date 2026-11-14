# draw.io's web app, as the drawio tool serves it to its editor's iframe: a tagged release, pinned by
# hash, without what an embedded, offline editor never loads.
{ pkgs }:
pkgs.stdenvNoCC.mkDerivation rec {
  pname = "drawio-webapp";
  version = "32.6.9";
  src = pkgs.fetchurl {
    url = "https://github.com/jgraph/drawio/releases/download/v${version}/draw.war";
    hash = "sha256-Ma/IK3kgxAnQWR9hJsy2w3fXgA5/EasyT4i98eQknOc=";
  };
  nativeBuildInputs = [ pkgs.unzip ];
  dontUnpack = true;
  installPhase = ''
    mkdir -p $out
    unzip -q $src -d $out
    cd $out
    # The Java servlet, cloud integrations, the separate viewer builds, the unminified sources that
    # app.min.js bundles, and the PWA's service worker.
    rm -rf WEB-INF META-INF connect js/diagramly js/grapheditor \
      js/integrate.min.js js/viewer.min.js js/viewer-static.min.js \
      service-worker.js service-worker.js.map workbox-*.js workbox-*.js.map \
      teams.html onedrive3.html vsdxImporter.html open.html clear.html export3.html \
      monday-app-association.json
  '';
}
