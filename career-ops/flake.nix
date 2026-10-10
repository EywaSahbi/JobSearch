{
  description = "career-ops - AI job search pipeline";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flakelight.url = "github:nix-community/flakelight";

    nixpkgs-pi.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { flakelight, nixpkgs, nixpkgs-pi, ... }:
    flakelight ./. {

      inputs.nixpkgs = nixpkgs;

      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      devShell.packages =
        pkgs:
        with pkgs; [

          nodejs
          bun

          nixpkgs-pi.legacyPackages.${pkgs.stdenv.hostPlatform.system}.pi-coding-agent

          coreutils

          playwright-driver.browsers

        ];

      devShell.env = pkgs: {
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      };

      devShell.shellHook = pkgs: ''
        # Pin npm playwright to match nixpkgs browser binaries
        EXPECTED="${pkgs.playwright-driver.version}"
        CURRENT=$(node -e "try{console.log(require('playwright-core/package.json').version)}catch{}" 2>/dev/null)
        if [ "$CURRENT" != "$EXPECTED" ]; then
          echo "Pinning playwright to $EXPECTED to match Nix-provided browsers..."
          npm install --no-save "playwright@$EXPECTED" >/dev/null 2>&1
        fi
      '';

    };

}
