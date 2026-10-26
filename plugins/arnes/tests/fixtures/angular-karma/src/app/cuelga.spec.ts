describe('Cuelga', () => {
  it('bloquea el navegador', () => {
    const fin = Date.now() + 10 * 60 * 1000;
    while (Date.now() < fin) {
      Math.sqrt(fin);
    }
    expect(true).toBe(true);
  });
});
