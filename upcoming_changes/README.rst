Filing Change Log Entries
=========================

de-shell uses `towncrier <https://towncrier.readthedocs.io/>`_ to assemble
``CHANGELOG.rst``. When you open a pull request that should appear in the next
release notes, add a short news **fragment file** to this directory as part of
that PR.

Writing the entry with the change — rather than deriving notes from commit
subjects at release time — is the whole point. A commit subject says what the
author was doing; a release note has to say what the change means to someone
upgrading, and only the author knows that. It also keeps two pull requests from
conflicting over the same few lines of a shared changelog: one fragment per PR,
no shared file to edit.

Who the reader is
-----------------

de-shell's users are the **apps** — SpyDE, Ground Crew, Autopilot — and the
people building them. Write for someone pinning a new ``de-shell`` and asking
what they get and what they have to change. Both halves of the package count:
the Python sidecar API and the TypeScript in ``de_shell/js`` (main, preload,
renderer, the Playwright harness).

Naming convention
-----------------

Each fragment is a plain ``.rst`` file named::

    {PR_number}.{type}.rst

If the change has no natural PR number (work batched on a long-lived feature
branch), name it ``+{slug}.{type}.rst`` — the leading ``+`` marks it an
"orphan" so towncrier omits the issue link. Without it the slug renders as a
broken PR link.

=================  ==============================================================
Type               Use when …
=================  ==============================================================
``api_change``     Existing behaviour changed in a way an app has to act on — a
                   signature, a default, a protocol message, an anyplotlib
                   floor. Use this even when the change is a *fix*: what
                   matters to someone upgrading is that the old behaviour is
                   gone, and that is easy to miss under ``bugfix``.
``new_feature``    A user-visible capability has been added.
``bugfix``         A bug has been fixed.
``performance``    Something measurably got faster or lighter. Quote the number
                   — "11.9 s to 40 ms per 64 MB frame" is a release note;
                   "improved performance" is not.
``deprecation``    Something is deprecated and will be removed later.
``removal``        A previously deprecated API has been removed.
``doc``            Documentation improved with no code change.
``maintenance``    Internal / infrastructure change invisible to the apps.
=================  ==============================================================

Content guidelines
------------------

* **One sentence per file**, in the **past tense**, from the *app's*
  perspective — not the implementer's.
* Say what changed for them, not which function you edited. "The packaged
  sidecar no longer holds the install directory open" beats "changed ``cwd`` in
  ``resolvePythonEnv``".
* Do **not** put the PR number in the sentence; towncrier appends the link.

Examples
--------

``12.bugfix.rst``::

    A figure opened on a zero-size pane stayed black until the window was
    resized.

``13.performance.rst``::

    The sidecar's stdout demuxer copies each byte once instead of re-copying
    the buffered prefix per chunk — 11.9 s to 40 ms for a 64 MB frame at
    64 KiB chunks.

Building
--------

The **Prepare Release** workflow runs ``towncrier build`` for you, so the
release PR carries the assembled changelog — see `Releasing
<../README.md#releasing>`_. To preview locally without consuming the
fragments::

    uv tool run towncrier build --draft --version X.Y.Z
