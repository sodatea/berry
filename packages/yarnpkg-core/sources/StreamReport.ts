import {Writable}                   from 'stream';

import {Configuration}              from './Configuration';
import {MessageName}                from './MessageName';
import {ProgressDefinition, Report} from './Report';
import {Locator}                    from './types';

export type StreamReportOptions = {
  configuration: Configuration,
  includeFooter?: boolean,
  includeInfos?: boolean,
  includeLogs?: boolean,
  includeWarnings?: boolean,
  json?: boolean,
  stdout: Writable,
};

const PROGRESS_FRAMES = [`⠋`, `⠙`, `⠹`, `⠸`, `⠼`, `⠴`, `⠦`, `⠧`, `⠇`, `⠏`];
const PROGRESS_INTERVAL = 80;

const FORGETTABLE_NAMES = new Set<MessageName | null>([MessageName.FETCH_NOT_CACHED]);
const FORGETTABLE_BUFFER_SIZE = 5;

const now = new Date();

// We only want to support environments that will out-of-the-box accept the
// characters we want to use. Others can enforce the style from the project
// configuration.
const supportsEmojis = [`iTerm.app`, `Apple_Terminal`].includes(process.env.TERM_PROGRAM!);

const makeRecord = <T>(obj: {[key: string]: T}) => obj;
const PROGRESS_STYLES = makeRecord({
  patrick: {
    date: [17, 3],
    chars: [`🍀`, `🌱`],
    size: 40,
  },
  simba: {
    date: [19, 7],
    chars: [`🌟`, `✨`],
    size: 40,
  },
  jack: {
    date: [31, 10],
    chars: [`🎃`, `🦇`],
    size: 40,
  },
  hogsfather: {
    date: [31, 12],
    chars: [`🎉`, `🎄`],
    size: 40,
  },
  default: {
    chars: [`=`, `-`],
    size: 80,
  },
});

const defaultStyle = (supportsEmojis && Object.keys(PROGRESS_STYLES).find(name => {
  const style = PROGRESS_STYLES[name];

  if (style.date && (style.date[0] !== now.getDate() || style.date[1] !== now.getMonth() + 1))
    return false;

  return true;
})) || `default`;

export class StreamReport extends Report {
  static async start(opts: StreamReportOptions, cb: (report: StreamReport) => Promise<void>) {
    const report = new this(opts);

    try {
      await cb(report);
    } catch (error) {
      report.reportExceptionOnce(error);
    } finally {
      await report.finalize();
    }

    return report;
  }

  private configuration: Configuration;
  private includeFooter: boolean;
  private includeInfos: boolean;
  private includeWarnings: boolean;
  private json: boolean;
  private stdout: Writable;

  private cacheHitCount: number = 0;
  private cacheMissCount: number = 0;

  private warningCount: number = 0;
  private errorCount: number = 0;

  private startTime: number = Date.now();

  private indent: number = 0;

  private progress: Map<AsyncIterable<ProgressDefinition>, ProgressDefinition> = new Map();
  private progressTime: number = 0;
  private progressFrame: number = 0;
  private progressTimeout: ReturnType<typeof setTimeout> | null = null;

  private forgettableLines: Array<string> = [];

  constructor({configuration, stdout, json = false, includeFooter = true, includeLogs = !json, includeInfos = includeLogs, includeWarnings = includeLogs}: StreamReportOptions) {
    super();

    this.configuration = configuration;
    this.includeFooter = includeFooter;
    this.includeInfos = includeInfos;
    this.includeWarnings = includeWarnings;
    this.json = json;
    this.stdout = stdout;
  }

  hasErrors() {
    return this.errorCount > 0;
  }

  exitCode() {
    return this.hasErrors() ? 1 : 0;
  }

  reportCacheHit(locator: Locator) {
    this.cacheHitCount += 1;
  }

  reportCacheMiss(locator: Locator) {
    this.cacheMissCount += 1;
  }

  startTimerSync<T>(what: string, cb: () => T) {
    this.reportInfo(null, `┌ ${what}`);

    const before = Date.now();
    this.indent += 1;

    try {
      return cb();
    } catch (error) {
      this.reportExceptionOnce(error);
      throw error;
    } finally {
      const after = Date.now();
      this.indent -= 1;

      if (this.configuration.get(`enableTimers`)) {
        this.reportInfo(null, `└ Completed in ${this.formatTiming(after - before)}`);
      } else {
        this.reportInfo(null, `└ Completed`);
      }
    }
  }

  async startTimerPromise<T>(what: string, cb: () => Promise<T>) {
    this.reportInfo(null, `┌ ${what}`);

    const before = Date.now();
    this.indent += 1;

    try {
      return await cb();
    } catch (error) {
      this.reportExceptionOnce(error);
      throw error;
    } finally {
      const after = Date.now();
      this.indent -= 1;

      if (this.configuration.get(`enableTimers`)) {
        this.reportInfo(null, `└ Completed in ${this.formatTiming(after - before)}`);
      } else {
        this.reportInfo(null, `└ Completed`);
      }
    }
  }

  reportSeparator() {
    if (this.indent === 0) {
      this.writeLineWithForgettableReset(``);
    } else {
      this.reportInfo(null, ``);
    }
  }

  reportInfo(name: MessageName | null, text: string) {
    if (!this.includeInfos)
      return;

    if (!this.json) {
      if (FORGETTABLE_NAMES.has(name)) {
        this.forgettableLines.push(text);
        if (this.forgettableLines.length > FORGETTABLE_BUFFER_SIZE) {
          while (this.forgettableLines.length > FORGETTABLE_BUFFER_SIZE)
            this.forgettableLines.shift();

          this.writeLines(name, this.forgettableLines);
        } else {
          this.writeLine(`${this.configuration.format(`➤`, `blueBright`)} ${this.formatName(name)}: ${this.formatIndent()}${text}`);
        }
      } else {
        this.writeLineWithForgettableReset(`${this.configuration.format(`➤`, `blueBright`)} ${this.formatName(name)}: ${this.formatIndent()}${text}`);
      }
    } else {
      this.reportJson({type: `info`, name, displayName: this.formatName(name), indent: this.formatIndent(), data: text});
    }
  }

  reportWarning(name: MessageName, text: string) {
    this.warningCount += 1;

    if (!this.includeWarnings)
      return;

    if (!this.json) {
      this.writeLineWithForgettableReset(`${this.configuration.format(`➤`, `yellowBright`)} ${this.formatName(name)}: ${this.formatIndent()}${text}`);
    } else {
      this.reportJson({type: `warning`, name, displayName: this.formatName(name), indent: this.formatIndent(), data: text});
    }
  }

  reportError(name: MessageName, text: string) {
    this.errorCount += 1;

    if (!this.json) {
      this.writeLineWithForgettableReset(`${this.configuration.format(`➤`, `redBright`)} ${this.formatName(name)}: ${this.formatIndent()}${text}`);
    } else {
      this.reportJson({type: `error`, name, displayName: this.formatName(name), indent: this.formatIndent(), data: text});
    }
  }

  reportProgress(progressIt: AsyncIterable<{progress: number, title?: string}>) {
    let stopped = false;

    const promise = Promise.resolve().then(async () => {
      const progressDefinition: ProgressDefinition = {
        progress: 0,
        title: undefined,
      };

      this.progress.set(progressIt, progressDefinition);
      this.refreshProgress(-1);

      for await (const {progress, title} of progressIt) {
        if (stopped)
          continue;
        if (progressDefinition.progress === progress && progressDefinition.title === title)
          continue;

        progressDefinition.progress = progress;
        progressDefinition.title = title;
        this.refreshProgress();
      }

      stop();
    });

    const stop = () => {
      if (stopped)
        return;

      stopped = true;

      this.progress.delete(progressIt);
      this.refreshProgress(+1);
    };

    return {...promise, stop};
  }

  reportJson(data: any) {
    if (this.json) {
      this.writeLineWithForgettableReset(`${JSON.stringify(data)}`);
    }
  }

  async finalize() {
    if (!this.includeFooter)
      return;

    let installStatus = ``;

    if (this.errorCount > 0)
      installStatus = `Failed with errors`;
    else if (this.warningCount > 0)
      installStatus = `Done with warnings`;
    else
      installStatus = `Done`;

    let fetchStatus = ``;

    if (this.cacheHitCount > 1)
      fetchStatus += ` - ${this.cacheHitCount} packages were already cached`;
    else if (this.cacheHitCount === 1)
      fetchStatus += ` - one package was already cached`;

    if (this.cacheHitCount > 0) {
      if (this.cacheMissCount > 1) {
        fetchStatus += `, ${this.cacheMissCount} had to be fetched`;
      } else if (this.cacheMissCount === 1) {
        fetchStatus += `, one had to be fetched`;
      }
    } else {
      if (this.cacheMissCount > 1) {
        fetchStatus += ` - ${this.cacheMissCount} packages had to be fetched`;
      } else if (this.cacheMissCount === 1) {
        fetchStatus += ` - one package had to be fetched`;
      }
    }

    const timing = this.formatTiming(Date.now() - this.startTime);
    const message = this.configuration.get(`enableTimers`)
      ? `${installStatus} in ${timing}${fetchStatus}`
      : installStatus;

    if (this.errorCount > 0) {
      this.reportError(MessageName.UNNAMED, message);
    } else if (this.warningCount > 0) {
      this.reportWarning(MessageName.UNNAMED, message);
    } else {
      this.reportInfo(MessageName.UNNAMED, message);
    }
  }

  private writeLine(str: string) {
    this.clearProgress({clear: true});
    this.stdout.write(`${str}\n`);
    this.writeProgress();
  }

  private writeLineWithForgettableReset(str: string) {
    this.forgettableLines = [];
    this.writeLine(str);
  }

  private writeLines(name: MessageName | null, lines: string[]) {
    this.clearProgress({delta: lines.length});

    for (const line of lines)
      this.stdout.write(`${this.configuration.format(`➤`, `blueBright`)} ${this.formatName(name)}: ${this.formatIndent()}${line}\n`);

    this.writeProgress();
  }

  private clearProgress({delta = 0, clear = false}: {delta?: number, clear?: boolean}) {
    if (!this.configuration.get(`enableProgressBars`) || this.json)
      return;

    if (this.progress.size + delta > 0) {
      this.stdout.write(`\x1b[${this.progress.size + delta}A`);
      if (delta > 0 || clear) {
        this.stdout.write(`\x1b[0J`);
      }
    }
  }

  private writeProgress() {
    if (!this.configuration.get(`enableProgressBars`) || this.json)
      return;

    if (this.progressTimeout !== null)
      clearTimeout(this.progressTimeout);

    this.progressTimeout = null;

    if (this.progress.size === 0)
      return;

    const now = Date.now();

    if (now - this.progressTime > PROGRESS_INTERVAL) {
      this.progressFrame = (this.progressFrame + 1) % PROGRESS_FRAMES.length;
      this.progressTime = now;
    }

    const spinner = PROGRESS_FRAMES[this.progressFrame];

    let styleName = this.configuration.get(`progressBarStyle`) || defaultStyle;
    if (!Object.prototype.hasOwnProperty.call(PROGRESS_STYLES, styleName))
      throw new Error(`Assertion failed: Invalid progress bar style`);

    // @ts-ignore
    const style = PROGRESS_STYLES[styleName];

    const PAD_LEFT = `➤ YN0000: ┌ `.length;

    const maxWidth = Math.min(process.stdout.columns - PAD_LEFT, 80);
    const scaledSize = Math.floor(style.size * maxWidth / 80);

    for (const {progress} of this.progress.values()) {
      const okSize = scaledSize * progress;

      const ok = style.chars[0].repeat(okSize);
      const ko = style.chars[1].repeat(scaledSize - okSize);

      this.stdout.write(`${this.configuration.format(`➤`, `blueBright`)} ${this.formatName(null)}: ${spinner} ${ok}${ko}\n`);
    }

    this.progressTimeout = setTimeout(() => {
      this.refreshProgress();
    }, 1000 / 60);
  }

  private refreshProgress(delta: number = 0) {
    this.clearProgress({delta});
    this.writeProgress();
  }

  private formatTiming(timing: number) {
    return timing < 60 * 1000
      ? `${Math.round(timing / 10) / 100}s`
      : `${Math.round(timing / 600) / 100}m`;
  }

  private formatName(name: MessageName | null) {
    const num = name === null ? 0 : name;
    const label = `YN${num.toString(10).padStart(4, `0`)}`;

    if (!this.json && name === null) {
      return this.configuration.format(label, `grey`);
    } else {
      return label;
    }
  }

  private formatIndent() {
    return `│ `.repeat(this.indent);
  }
}
