import { DatabaseError } from './errors';
import { DATABASE_VERSION, runMigrations } from './migrations';

/** Owns one cached connection, including requests that finish after close/retry. */
export class DatabaseConnection {
  private pending: Promise<IDBDatabase> | undefined;
  private generation = 0;

  constructor(
    private readonly factory: IDBFactory,
    private readonly name: string,
  ) {}

  open(): Promise<IDBDatabase> {
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const pending: Promise<IDBDatabase> = this.connect(generation).catch((error: unknown) => {
      if (this.pending === pending) this.pending = undefined;
      throw error;
    });
    this.pending = pending;
    return pending;
  }

  close(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.generation++;
    void pending?.then((database) => database.close()).catch(() => undefined);
  }

  private connect(generation: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, DATABASE_VERSION);
      let failed = false;
      const fail = (message: string, cause?: unknown) => {
        failed = true;
        reject(new DatabaseError('OPEN_FAILED', message, cause));
      };
      request.addEventListener('upgradeneeded', (event) => {
        const transaction = request.transaction;
        if (!transaction) {
          fail('IndexedDB did not provide an upgrade transaction.');
          return;
        }
        try {
          runMigrations(
            request.result,
            transaction,
            event.oldVersion,
            event.newVersion ?? DATABASE_VERSION,
          );
        } catch (error) {
          transaction.abort();
          fail('ValRecall could not upgrade its local database.', error);
        }
      });
      request.addEventListener(
        'success',
        () => {
          const database = request.result;
          if (failed || generation !== this.generation) {
            // Rejecting a blocked open does not cancel the native IDB request.
            database.close();
          } else {
            const invalidate = () => {
              database.close();
              if (generation === this.generation) this.pending = undefined;
            };
            database.addEventListener('versionchange', invalidate, { once: true });
            database.addEventListener('close', invalidate, { once: true });
          }
          resolve(database);
        },
        { once: true },
      );
      request.addEventListener(
        'error',
        () => {
          fail('ValRecall could not open its local database.', request.error);
        },
        { once: true },
      );
      request.addEventListener(
        'blocked',
        () => {
          fail('A previous ValRecall tab is blocking a database upgrade. Close it and retry.');
        },
        { once: true },
      );
    });
  }
}
