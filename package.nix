{
  pkgs,
  # Make claude-code overridable
  claude-code,
  # Sandbox runtime (srt) for cross-platform sandboxing
  sandbox-runtime,
  # Keep this so package.nix can be copied into llm-agents.nix
  sourceDir ? ./src,
}:
let
  inherit (pkgs.stdenv) isLinux;

  # Bundle all the tools Claude needs into a single environment
  claudeTools = pkgs.buildEnv {
    name = "claude-tools";
    paths = with pkgs; [
      # Essential tools Claude commonly uses
      git
      ripgrep
      fd
      coreutils
      gnugrep
      gnused
      gawk
      findutils
      which
      tree
      curl
      wget
      jq
      less
      # Shells
      zsh
      # Nix is essential for nix run
      nix
    ];
  };

in
pkgs.runCommand "claudebox"
  {
    buildInputs = [ pkgs.makeWrapper ];
    meta = with pkgs.lib; {
      mainProgram = "claudebox";
      description = "Sandboxed environment for Claude Code";
      homepage = "https://github.com/numtide/claudebox";
      sourceProvenance = with sourceTypes; [ fromSource ];
      platforms = platforms.linux ++ platforms.darwin;
    };
  }
  ''
    mkdir -p $out/bin $out/libexec/claudebox

    # Install claudebox launcher script
    cp ${sourceDir}/claudebox.js $out/libexec/claudebox/claudebox.js

    # Link srt node_modules for library access
    ln -s ${sandbox-runtime}/lib/node_modules $out/libexec/claudebox/node_modules

    # Create claudebox executable
    makeWrapper ${pkgs.nodejs}/bin/node $out/bin/claudebox \
      --add-flags $out/libexec/claudebox/claudebox.js \
      --prefix PATH : ${
        pkgs.lib.makeBinPath (
          [
            pkgs.bashInteractive
            claudeTools
          ]
          ++ pkgs.lib.optionals isLinux [
            pkgs.bubblewrap
            pkgs.socat
          ]
        )
      }:$out/libexec/claudebox

    # Create claude wrapper
    makeWrapper ${claude-code}/bin/.claude-wrapped $out/libexec/claudebox/claude \
      --set DISABLE_AUTOUPDATER 1 \
      --inherit-argv0
  ''
