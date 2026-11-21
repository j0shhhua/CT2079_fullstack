'use strict';

// Both the administrator page and hosting operator use the same approval transition.
async function approveOrganiser(pool, selector) {
  const cl = await pool.connect();
  try {
    await cl.query('begin');
    const byId = selector.id !== undefined;
    const user = (await cl.query(`select id,email,organiser_approved from users
      where ${byId ? 'id::text=$1' : 'lower(email)=lower($1)'} and role='organiser' and not disabled for update`,
    [byId ? selector.id : selector.email])).rows[0];
    if (!user) throw Object.assign(new Error('Active organiser account not found. Customer accounts must request organiser access first.'), { s: 404 });
    if (!user.organiser_approved) {
      await cl.query('delete from browser_sessions where user_id=$1', [user.id]);
      await cl.query('update recovery_challenges set consumed_at=now() where user_id=$1 and consumed_at is null', [user.id]);
      await cl.query('update users set organiser_approved=true where id=$1', [user.id]);
    }
    await cl.query('commit');
    return { id: user.id, alreadyApproved: user.organiser_approved };
  } catch (e) {
    await cl.query('rollback');
    throw e;
  } finally { cl.release(); }
}

module.exports = { approveOrganiser };
