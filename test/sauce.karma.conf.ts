let browsers = {
  sl_chrome: {
    username: "ender336",
    accessKey: "fcfad206-6db2-46bc-8824-c1e576d549cf",
    base: "SauceLabs",
    browserName: "chrome",
    platform: "Windows 7",
    version: "35",
    recordScreenshots: true
  }
};

export = (config) => {
  config.set({
    basePath: "..",
    logLevel: "LOG_DEBUG",
    singleRun : false,
    autoWatch : false,

    frameworks: ["mocha", "chai", "jasmine", "browserify"],

    files: [
        "test/clarity.fixture.html",
        // "test/test.js"
        "test/basicEventValidation.js"
    ],

    preprocessors: {
        "test/basicEventValidation.js": ["browserify", "regex"],
        "test/*.html": ["html2js"]
    },

    plugins: [
      "karma-mocha",
      "karma-chai",
      "karma-jasmine",
      "karma-sauce-launcher",
      "karma-spec-reporter",
      "karma-html2js-preprocessor",
      "karma-browserify",
      "karma-regex-preprocessor"
    ],

    reporters: ["saucelabs", "spec"],

    regexPreprocessor: {
      rules: [
        {
          // Replacements for basicEventValidation.js.
          fileName: "basicEventValidation.js", replacement: [
            { replace: "const ", with: "var " }
          ]
        }
      ]
    },

    sauceLabs: {
        public: "public",
        testName: "Basic Web Test",
        tunnelIdentifier: process.env.TRAVIS_JOB_NUMBER,
        startConnect: false,
        connectOptions: {
             username: "ender336",
             accessKey: "fcfad206-6db2-46bc-8824-c1e576d549cf",
      },
    },
    browsers: Object.keys(browsers),
    customLaunchers: browsers
  });
};
