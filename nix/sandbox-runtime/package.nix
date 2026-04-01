{
  lib,
  stdenv,
  buildNpmPackage,
  fetchzip,
  makeWrapper,
  nodejs,
  runCommand,
  bubblewrap ? null,
  socat ? null,
  ripgrep,
}:

let
  versionData = builtins.fromJSON (builtins.readFile ./hashes.json);
  inherit (versionData) version hash npmDepsHash;

  src = runCommand "sandbox-runtime-src-with-lock" { } ''
    mkdir -p $out
    cp -r ${
      fetchzip {
        url = "https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-${version}.tgz";
        inherit hash;
      }
    }/* $out/
    cp ${./package-lock.json} $out/package-lock.json
  '';
in
buildNpmPackage {
  pname = "sandbox-runtime";
  inherit version src;

  npmDepsHash = npmDepsHash;

  nativeBuildInputs = [ makeWrapper ];
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;

  # Make network config optional: patch schema + inject no-op stub at runtime
  postPatch = ''
    # 1. Schema: make network field optional
    sed -i 's/network: NetworkConfigSchema\.describe/network: NetworkConfigSchema.optional().describe/' \
      dist/sandbox/sandbox-config.js

    # 2. Runtime: inject stub when network is omitted (prevents null-reference errors)
    #    allowedDomains left undefined so hasNetworkConfig=false → no network restriction
    sed -i '/config = runtimeConfig;/a\
    if (!config.network) { config.network = { deniedDomains: [] }; }' \
      dist/sandbox/sandbox-manager.js
  '';

  postInstall = lib.optionalString stdenv.hostPlatform.isLinux ''
    wrapProgram $out/bin/srt \
      --suffix PATH : ${lib.makeBinPath (lib.filter (x: x != null) [ bubblewrap socat ripgrep ])}
  '';

  doInstallCheck = false;

  meta = {
    description = "Lightweight sandboxing tool for enforcing filesystem and network restrictions";
    homepage = "https://github.com/anthropic-experimental/sandbox-runtime";
    license = lib.licenses.asl20;
    sourceProvenance = with lib.sourceTypes; [ fromSource ];
    mainProgram = "srt";
    platforms = lib.platforms.unix;
  };
}
