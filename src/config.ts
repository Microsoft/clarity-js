// Get a reference to script tag responsible for executing clarity script
export let config: IConfig = {
  delay: 500,
  batchLimit: 100 * 1024, // 100 kilobytes
  totalLimit: 20 * 1024 * 1024,  // 20 megabytes
  uploadUrl: "",
  showText: false,
  instrument: false,
  timeToYield: 50,
  activateEvent: "",
  debug: false
};
