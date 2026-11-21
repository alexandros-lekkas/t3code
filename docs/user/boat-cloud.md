# Boat

T3 Code can run threads on [Boat](https://boat.dev) VMs instead of your machine. Each VM runs its
own T3 Code server, so a cloud thread works like any other thread: it streams, keeps its history,
and you can follow it from any client.

## Set it up

1. Create a Boat API key with these scopes: `sandbox.create`, `sandbox.read`, `sandbox.update`,
   `sandbox.stop`, `sandbox.resume`, `sandbox.delete`, `exec`, `file.read`, `file.write`, `host`,
   `ssh`, `snapshot.read`, `snapshot.write`, `account.read`, `account.admin`, `environment.read`,
   `environment.write`. `account.admin` lets T3 Code see which agent sign-ins you added, never
   their values.
2. Open **Settings → Boat**, paste the key under **Account**, and choose **Connect**. The key is
   saved on every connected machine.
3. Setup starts on its own: T3 Code creates a VM, installs the T3 Code server so it starts on
   boot, clones your most worked repositories, copies your machine's skills, and saves a Boat
   snapshot named `t3-code`. Every cloud VM starts from it. Choose **Rebuild** next to
   **Snapshot**, under **New machines**, after you change your skills or update T3 Code.
4. Under **Account**, the account row says whether threads can start, and **Boat environment**
   chooses the Boat environment new VMs start on. It starts on Boat's default.
5. **Agent sign-ins** has a row for Claude and one for Codex saying where VMs get each sign-in. A
   thread cannot start without at least one.
   - **From this computer** (on by default) gives VMs this computer's Claude Code and Codex
     sign-ins. Your Claude login reaches VMs for a few hours at a time; choose **Create token** on
     the Claude row once to sign in to Claude in the browser and make a token that lasts a year. A
     Codex login reaches VMs for several days. VMs get them each time they start or wake.
   - **From Boat** gives VMs the sign-ins saved in the Boat environment. Choose **Add** or
     **Manage** to open Boat's [Agents & Proxying](https://boat.dev/dashboard?tab=agents) page.
6. **Machine access** sets what else the Boat environment gives each VM:
   - **GitHub** lets VMs clone private repositories and push. If Boat's GitHub app is not
     connected, for example because you signed in to Boat with Google or email, choose **Connect**
     to open Boat's [Environment](https://boat.dev/dashboard?tab=environment) page.
   - **Secrets** gives VMs the environment's variables and secret files.
   - **Boat API key** puts a Boat key for your account on each VM, so agents there can start, stop
     and delete VMs billed to you. T3 Code does not need it; leave it off unless an agent must
     manage VMs itself.

   A VM keeps the environment it started on, even after it stops, so a change only applies to new
   VMs.

## Start a cloud thread

In a new thread, open the machine picker and choose **Boat**, or use **New Boat thread**
in the command palette. If Boat cannot start a thread yet, for example because neither its environment
nor this computer has an agent sign-in, the composer says so with a link to the setting to fix. A VM starts getting ready
as soon as you pick Boat. When you send the
first message, it shows in the thread right away, and the app lists each step as it runs: finding a
VM, starting T3 Code, cloning or updating the repository, connecting, opening the project, and
starting the thread, which lives on the VM from then on. T3 Code reuses a running VM that is under
half its CPU and memory, preferring one that already has the repository, or starts a new VM from the
snapshot. A VM from the snapshot is usually ready in under 10 seconds.

Next to the machine picker, choose the VM size: Small, Medium, Large or Extra large. Each size lists its vCPUs, memory and hourly price;
a size your Boat plan cannot start is shown with the reason. New threads use the **Default size**
under **Settings → Boat → New machines** unless you pick another. With **Share machines** off, each cloud thread
gets a VM of its own; turn it on to let threads join a running VM that has room. **Keep a ready
machine** keeps an idle VM at the default size running while you use T3 Code, so a start skips the
boot. That VM is billed at its hourly price; it is off by default, and turning it off deletes the
idle VM. The thread's details panel shows its VM's size, state, CPU, memory, disk and cost.

To give a VM more memory, change its size: on web and desktop from the size in the thread's details
panel, and on any client with **Resize** next to the VM under **Settings → Boat → Machines**. It
stays the same VM, with the same threads, worktrees and uncommitted changes, and its cost keeps
counting. Resizing restarts the VM, so everything running on it stops, in every thread sharing it;
running turns continue on their own once it is back. A sleeping VM wakes on the new size. Boat
refuses a smaller size when the VM's data does not fit on it.

A cloud thread always works in a new worktree, so several threads can share a VM. You choose only
the base branch. The thread keeps your model and access settings, and its attachments go with it.

The project needs a pushed Git remote: the VM clones it, so local-only branches and commits are not
there. When an agent finishes, it commits and pushes its branch. It opens a pull request only when
you ask. Providers on a VM use the agent sign-ins from its Boat environment and, where it has none,
this computer's, so a cloud thread only offers the providers those sign-ins cover.

## When VMs stop

A VM turns off once none of its threads has run a turn or waited on background work it started,
such as a build, for 10 minutes. Neither keeps it on past 6 hours without a message or a wake. A connected machine holding
the key stops it a minute early and first saves a copy of the VM's threads, provider sessions, and
checkouts. Settling every thread on a VM stops it the same way about a minute later, without the
wait. A thread on a stopped VM shows it as sleeping. Your next message turns the same VM back
on and the thread continues. If Boat deleted the VM, a new one starts from the saved copy.
**Machines**, in **Settings → Boat**, lists each VM by its
threads, with its size and cost, and lets you stop, wake, resize or delete it. VMs are not listed with your
other environments.

An agent can also start a thread on Boat for you. Its VM's threads show in your thread list once
this client connects to the VM, which it does on its own while the VM runs, or when you open a link
to one of its threads.
