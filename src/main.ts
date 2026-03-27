import { Plugin, Notice } from "obsidian";
import { CalendarService } from "./services/CalendarService";
import { NoteService } from "./services/NoteService";
import { CalendarView } from "./views/CalendarView";
import { SettingsTab } from "./settings/SettingsTab";
import { MemoChronSettings, DEFAULT_SETTINGS } from "./settings/types";
import { MEMOCHRON_VIEW_TYPE } from "./utils/constants";
import { EmbeddedCalendarView, parseCalendarCodeBlock } from "./views/EmbeddedCalendarView";
import { EmbeddedAgendaView, parseAgendaCodeBlock } from "./views/EmbeddedAgendaView";

export default class MemoChron extends Plugin {
  settings: MemoChronSettings;
  calendarService: CalendarService;
  noteService: NoteService;
  calendarView: CalendarView;
  private refreshTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.initializeServices();
    this.registerViews();
    this.registerCommands();
    this.registerCodeBlockProcessors();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      await this.activateView();
      if (this.settings.autoCreateNotesOnLaunch) {
        await this.autoCreateNotesForToday();
      }
    });

    this.setupAutoRefresh();
  }

  private initializeServices() {
    this.calendarService = new CalendarService(
      this,
      this.settings.refreshInterval
    );
    this.noteService = new NoteService(this.app, this.settings);
  }

  private registerViews() {
    this.registerView(
      MEMOCHRON_VIEW_TYPE,
      (leaf) => (this.calendarView = new CalendarView(leaf, this))
    );
  }

  private registerCommands() {
    this.addCommand({
      id: "force-refresh-calendars",
      name: "Force refresh calendars",
      callback: () => this.refreshCalendarView(true),
    });

    this.addCommand({
      id: "go-to-today",
      name: "Go to today",
      callback: () => this.goToToday(),
    });

    this.addCommand({
      id: "toggle-calendar",
      name: "Toggle calendar visibility",
      callback: () => this.toggleCalendar(),
    });
  }

  private registerCodeBlockProcessors() {
    // Register calendar code block processor
    this.registerMarkdownCodeBlockProcessor(
      "memochron-calendar",
      (source, el, ctx) => {
        const params = parseCalendarCodeBlock(source);
        const filename = ctx.sourcePath ? ctx.sourcePath.split('/').pop() : undefined;
        const context = { filename };
        const calendarView = new EmbeddedCalendarView(el, this, params, context);
        ctx.addChild(calendarView);
      }
    );

    // Register agenda code block processor
    this.registerMarkdownCodeBlockProcessor(
      "memochron-agenda",
      (source, el, ctx) => {
        const params = parseAgendaCodeBlock(source);
        const filename = ctx.sourcePath ? ctx.sourcePath.split('/').pop() : undefined;
        const context = { filename };
        const agendaView = new EmbeddedAgendaView(el, this, params, context);
        ctx.addChild(agendaView);
      }
    );
  }

  onunload() {
    this.clearRefreshTimer();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);

    if (this.calendarService) {
      this.setupAutoRefresh();
    }

    await this.refreshCalendarView();
  }

  private async activateView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(MEMOCHRON_VIEW_TYPE);

    if (existingLeaves.length === 0) {
      await this.createCalendarView();
    }

    await this.refreshCalendarView();
  }

  private async createCalendarView() {
    const leaf = this.getOrCreateLeaf();

    if (leaf) {
      await leaf.setViewState({
        type: MEMOCHRON_VIEW_TYPE,
        active: true,
      });
    }
  }

  private getOrCreateLeaf() {
    const rightLeaf = this.app.workspace.getRightLeaf(false);
    return rightLeaf || this.app.workspace.getLeaf("split", "vertical");
  }

  async refreshCalendarView(forceRefresh = false) {
    if (this.calendarView) {
      await this.calendarView.refreshEvents(forceRefresh);
    }
  }

  updateCalendarColors() {
    if (this.calendarView) {
      this.calendarView.updateColors();
    }
  }

  private async goToToday() {
    if (this.calendarView) {
      await this.calendarView.goToToday();
    }
  }

  async toggleCalendar() {
    this.settings.hideCalendar = !this.settings.hideCalendar;
    await this.saveSettings();
    if (this.calendarView) {
      this.calendarView.toggleCalendarVisibility();
    }
  }

  private setupAutoRefresh() {
    this.clearRefreshTimer();

    const intervalMs = this.settings.refreshInterval * 60 * 1000;
    this.refreshTimer = window.setInterval(
      () => this.refreshCalendarView(),
      intervalMs
    );
  }

  private clearRefreshTimer() {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async autoCreateNotesForToday(): Promise<void> {
    if (!this.settings.noteLocation) return;

    const today = new Date();
    const events = this.calendarService.getEventsForWidget(today);

    // Guard: if events weren't loaded (e.g., no calendars configured), do nothing silently
    if (events.length === 0) return;

    let created = 0;
    let skipped = 0;

    for (const event of events) {
      if (event.isAllDay) continue; // Skip all-day events (holidays, OOO, etc.)

      if (this.noteService.getExistingEventNote(event)) {
        skipped++;
        continue;
      }

      try {
        await this.noteService.createEventNote(event);
        created++;
      } catch (error) {
        console.error("MemoChron: Failed to auto-create note for:", event.title, error);
      }
    }

    // Only show a notice when notes were actually created — subsequent launches where
    // all notes already exist are intentionally silent (safe no-op behavior)
    if (created > 0) {
      const suffix = skipped > 0 ? `, ${skipped} already existed` : "";
      new Notice(
        `MemoChron: ${created} meeting note${created !== 1 ? "s" : ""} created${suffix}`
      );
    }
  }
}
