import setup, {
  hideLoadingAnimation,
  showErrorScreen,
  showLoadingAnimation,
} from "@inkandswitch/patchwork";

showLoadingAnimation();

// Only the base modules served by this site, from @inkandswitch/patchwork-pkg-base.
window.patchwork = await setup({
  packageListURL: "/modules.json",
  accountKey: "harnessAccountUrl",
  frameToolId: "threepane",
}).catch((error: unknown) => {
  showErrorScreen(error);
  throw error;
});

hideLoadingAnimation();
