/** Jest runs the TypeScript sources directly through ts-jest, so tests never
 *  depend on `npm run build` having been executed first. */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  clearMocks: true
};
