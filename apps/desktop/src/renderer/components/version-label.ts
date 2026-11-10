/** The sidebar footer: `0.0.0-alpha.N` reads `Cockpit Alpha N`, any other version is shown as it is. */
export function versionLabel(version: string): string {
  const alpha = /^0\.0\.0-alpha\.(\d+)$/.exec(version);
  return alpha ? `Cockpit Alpha ${alpha[1]}` : `Cockpit ${version}`;
}
