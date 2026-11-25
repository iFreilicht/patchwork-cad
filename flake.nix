{
  description = "patchwork-cad development environment";

  inputs = {
    patchwork-system.url = "github:inkandswitch/patchwork-system";
    # Same nixpkgs as Patchwork, so tool versions match Patchwork's.
    nixpkgs.follows = "patchwork-system/nixpkgs";
    # Playwright's browsers only, which must match @playwright/test: 1.59.1's Firefox runs wasm without
    # its optimizing compiler, because Juggler debugs every page and worker without `allowUnobservedWasm`.
    nixpkgs-playwright.url = "github:nixos/nixpkgs/nixos-unstable";
    # Rust build; only its binary is used, so it keeps its own nixpkgs.
    subduction.url = "github:inkandswitch/subduction";
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-playwright,
      subduction,
      ...
    }:
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

            # draw.io's web app, which the drawio tool's build copies next to its bundle.
            DRAWIO_WEBAPP = import ./src/drawio/webapp.nix { inherit pkgs; };

            # Fonts that SVG texts are drawn in: the CAD tool's build bundles them, the feature library's tests read them.
            CAD_FONTS = "${pkgs.liberation_ttf}/share/fonts/truetype";

            # Playwright uses the Nix-provided browsers (no download).
            PLAYWRIGHT_BROWSERS_PATH = nixpkgs-playwright.legacyPackages.${system}.playwright-driver.browsers;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          };
        }
      );

      packages = forAllSystems (
        _: pkgs: {
          drawio-webapp = import ./src/drawio/webapp.nix { inherit pkgs; };
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
