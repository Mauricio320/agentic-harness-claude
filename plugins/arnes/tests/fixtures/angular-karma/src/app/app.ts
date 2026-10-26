import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `<h1>{{ titulo() }}</h1>`,
})
export class App {
  protected readonly titulo = signal('arnes-karma');
}
