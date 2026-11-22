/**
 * Storage of the background jobs waiting to run (`scheduled_job`), e.g. a retry of the token
 * revocations, with how many times each has been tried, for backing off.
 * @import { Database } from '../../types.js';
 */

/**
 * A job, as stored.
 * @typedef {object} JobRow
 * @property {string} name Job name.
 * @property {number} due_at When it’s due.
 * @property {number} attempts Number of attempts so far.
 */

/**
 * Get a job.
 * @param {Database} db Database.
 * @param {string} name Job name.
 * @returns {Promise<JobRow | undefined>} Job, if scheduled.
 */
export const getJobRow = (db, name) =>
  db.selectFrom('scheduled_job').selectAll().where('name', '=', name).executeTakeFirst();

/**
 * Schedule a job, replacing its current schedule.
 * @param {Database} db Database.
 * @param {JobRow} job Job.
 * @returns {Promise<void>}
 */
export const putJobRow = async (db, job) => {
  await db
    .insertInto('scheduled_job')
    .values(job)
    .onConflict((oc) =>
      oc.column('name').doUpdateSet((eb) => ({
        due_at: eb.ref('excluded.due_at'),
        attempts: eb.ref('excluded.attempts'),
      })),
    )
    .execute();
};

/**
 * Remove a job, once it’s done.
 * @param {Database} db Database.
 * @param {string} name Job name.
 * @returns {Promise<void>}
 */
export const deleteJobRow = async (db, name) => {
  await db.deleteFrom('scheduled_job').where('name', '=', name).execute();
};

/**
 * Get when the next job is due.
 * @param {Database} db Database.
 * @returns {Promise<number | null>} Time, if any job is scheduled.
 */
export const getNextJobDueAt = async (db) => {
  const row = await db
    .selectFrom('scheduled_job')
    .select(({ fn }) => fn.min('due_at').as('next'))
    .executeTakeFirst();

  return row?.next == null ? null : Number(row.next);
};
