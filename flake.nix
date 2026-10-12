{
  description = "patchwork-cad development environment";

  inputs = {
    patchwork-system.url = "github:inkandswitch/patchwork-system";
    # Same nixpkgs as Patchwork, so playwright-driver matches @playwright/test.
    nixpkgs.follows = "patchwork-system/nixpkgs";
    # Rust build; only its binary is used, so it keeps its own nixpkgs.
    subduction.url = "github:inkandswitch/subduction";
  };

  outputs =
    { nixpkgs, subduction, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
              pkgs.python3
              subduction.packages.${system}.subduction_cli
            ];

            # Playwright uses the Nix-provided browsers (no download).
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };
        }
      );

      checks = forAllSystems (
        _: pkgs: {
          harness-vm-spike = import ./src/harness/vm/spike.nix { inherit pkgs; };
        }
      );

      formatter = forAllSystems (_: pkgs: pkgs.nixfmt-rfc-style);
    };
}
