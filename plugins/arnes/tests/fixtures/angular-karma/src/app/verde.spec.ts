import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { App } from './app';

describe('Verde', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [App], providers: [provideZonelessChangeDetection()] }));

  it('crea la app', () => {
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });

  describe('el título', () => {
    it('lo pinta en el h1', async () => {
      const fixture = TestBed.createComponent(App);
      await fixture.whenStable();
      expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe('arnes-karma');
    });
  });
});
