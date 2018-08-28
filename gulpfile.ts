import * as del from "del";
import * as gulp from "gulp";
import * as rename from "gulp-rename";
import * as ts from "gulp-typescript";
import * as uglify from "gulp-uglify";
import * as karma from "karma";
import * as typescript from "rollup-plugin-typescript2";
import * as rollup from "rollup-stream";
import * as source from "vinyl-source-stream";

declare const __dirname;
const tsProject = ts.createProject("tsconfig.json");
const bundle = "clarity.js";
const minifiedBundle = "clarity.min.js";
const karmaServer = karma.Server;

gulp.task("uglify", () => {
  return gulp.src("build/" + bundle)
    .pipe(uglify())
    .pipe(rename(minifiedBundle))
    .pipe(gulp.dest("build"));
});

gulp.task("rollup", () => {
  return rollup({
    input: "./src/clarity.ts",
    format: "umd",
    name: "clarity",
    plugins: [
      (typescript as any)()
    ]
  })
    .pipe(source(bundle))
    .pipe(gulp.dest("build"));
});

gulp.task("clean", (done) => {
  del("build");
  done();
});

gulp.task("compile", () => {
  return tsProject.src()
    .pipe(tsProject())
    .js
    .pipe(gulp.dest(tsProject.config.compilerOptions.outDir));
});

gulp.task("place-fixture", () => {
  return gulp.src("test/clarity.fixture.html")
    .pipe(gulp.dest("build/test"));
});

gulp.task("test", (done) => {
  new karmaServer({
    configFile: __dirname + "/build/test/karma.conf.js",
    singleRun: true
  }, done).start();
});

gulp.task("test-debug", (done) => {
  new karmaServer({
    configFile: __dirname + "/build/test/karma.conf.js",
    singleRun: false
  }, done).start();
});

gulp.task("coverage", (done) => {
  new karmaServer({
    configFile: __dirname + "/build/test/coverage.conf.js"
  }, done).start();
});

gulp.task("build", gulp.series(
  "clean",
  "compile",
  "place-fixture",
  "rollup",
  "uglify"
));

// build and then run coverage
gulp.task("bnc", gulp.series(
  "clean",
  "compile",
  "place-fixture",
  "rollup",
  "uglify",
  "coverage"
));

// build and then run tests
gulp.task("bnt", gulp.series(
  "clean",
  "compile",
  "place-fixture",
  "rollup",
  "uglify",
  "test"
));
