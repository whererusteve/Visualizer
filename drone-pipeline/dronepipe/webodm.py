"""Step 4 - PROCESS: talk to WebODM through its REST API.

What's a REST API? WebODM's web page is built on top of a set of web
addresses ("endpoints") that accept and return data. Anything you can
click in WebODM, a program can do by visiting those addresses. We use the
"requests" library to do that.

The endpoints used here (from WebODM's API docs, docs.webodm.org):

  POST /api/token-auth/                          log in, get a token
  GET  /api/projects/                            list projects
  POST /api/projects/                            create a project
  GET  /api/processingnodes/                     list processing engines + their options
  POST /api/projects/{p}/tasks/                  create a task
  POST /api/projects/{p}/tasks/{t}/upload/       add photos to a task
  POST /api/projects/{p}/tasks/{t}/commit/       "all photos uploaded, start!"
  GET  /api/projects/{p}/tasks/{t}/              task status / progress
  GET  /api/projects/{p}/tasks/{t}/output/       processing console text
  GET  /api/projects/{p}/tasks/{t}/download/{asset}  download a result

CONFIDENCE NOTE: login, projects, task status and downloads are the
well-documented core. The three-step upload (create with partial=true ->
upload -> commit) is how WebODM's own web page uploads photos, and is
what I'm least able to verify without your actual install. If it fails,
the error will say which step - please send me the message.
"""

import json
import os
import time
from getpass import getpass
from pathlib import Path

import requests

# WebODM's numeric status codes, turned into words.
STATUS_NAMES = {10: "QUEUED", 20: "RUNNING", 30: "FAILED", 40: "COMPLETED", 50: "CANCELED"}
QUEUED, RUNNING, FAILED, COMPLETED, CANCELED = 10, 20, 30, 40, 50


class WebODMError(Exception):
    """Something went wrong talking to WebODM. Messages explain what to check."""


class WebODM:
    def __init__(self, url, username, password=None, timeout=60):
        self.url = url.rstrip("/")
        self.username = username
        self.timeout = timeout
        # A Session reuses the connection and remembers our login header.
        self.session = requests.Session()
        self._login(password)

    # ------------------------------------------------------------------
    # Basic plumbing
    # ------------------------------------------------------------------
    def _login(self, password):
        """Swap username + password for a 'token' (like a temporary key card)."""
        if password is None:
            password = os.environ.get("WEBODM_PASSWORD") or getpass(
                f"WebODM password for '{self.username}': ")
        try:
            resp = self.session.post(f"{self.url}/api/token-auth/",
                                     data={"username": self.username, "password": password},
                                     timeout=self.timeout)
        except requests.ConnectionError:
            raise WebODMError(
                f"Can't reach WebODM at {self.url}. Is it running? Open that address in "
                "your browser to check. (Docker install: is Docker Desktop running and "
                "did you start WebODM?)") from None
        if resp.status_code != 200 or "token" not in resp.text:
            raise WebODMError("WebODM refused the login. Check the username in config.toml "
                              "and your password.")
        token = resp.json()["token"]
        # Every later request carries this header to prove who we are.
        self.session.headers["Authorization"] = f"JWT {token}"

    def _request(self, method, path, what, **kwargs):
        """Send one request and turn failures into readable errors.
        'what' describes the step, so error messages say where it broke."""
        kwargs.setdefault("timeout", self.timeout)
        try:
            resp = self.session.request(method, f"{self.url}{path}", **kwargs)
        except requests.RequestException as e:
            raise WebODMError(f"Network problem while trying to {what}: {e}") from None
        if resp.status_code >= 400:
            raise WebODMError(f"WebODM said no while trying to {what} "
                              f"(HTTP {resp.status_code}): {resp.text[:300]}")
        return resp

    @staticmethod
    def _as_list(data):
        # Some WebODM lists come back "paginated" as {"results": [...]}.
        return data["results"] if isinstance(data, dict) and "results" in data else data

    # ------------------------------------------------------------------
    # Projects and options
    # ------------------------------------------------------------------
    def get_or_create_project(self, name, description=""):
        """One WebODM project per site. Reuse it if it already exists."""
        projects = self._as_list(self._request("GET", "/api/projects/", "list projects").json())
        for p in projects:
            if p.get("name") == name:
                return p["id"]
        resp = self._request("POST", "/api/projects/", "create a project",
                             data={"name": name, "description": description})
        return resp.json()["id"]

    def known_option_names(self):
        """Ask the processing engine (NodeODM) which option names it accepts.
        Returns a set of names, or None if we couldn't find out."""
        try:
            nodes = self._as_list(self._request("GET", "/api/processingnodes/",
                                                "list processing nodes").json())
        except WebODMError:
            return None
        names = set()
        for node in nodes:
            for opt in node.get("available_options") or []:
                names.add(opt.get("name"))
        return names or None

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------
    def create_task(self, project_id, name, options, image_paths, progress=True):
        """Create a task, upload photos one at a time, then start processing.

        'options' is the preset dictionary from config.toml, e.g.
        {"pc-quality": "high", "dsm": True}. WebODM wants it as a list of
        {"name": ..., "value": ...} pairs written out as JSON text.
        """
        options_json = json.dumps([{"name": k, "value": v} for k, v in options.items()])
        task = self._request(
            "POST", f"/api/projects/{project_id}/tasks/", "create the processing task",
            data={"name": name, "options": options_json, "partial": "true"}).json()
        task_id = task["id"]

        total = len(image_paths)
        for i, path in enumerate(image_paths, start=1):
            path = Path(path)
            with open(path, "rb") as fh:   # read-only
                self._request(
                    "POST", f"/api/projects/{project_id}/tasks/{task_id}/upload/",
                    f"upload {path.name}",
                    files={"images": (path.name, fh, "image/jpeg")},
                    timeout=600)
            if progress:
                print(f"\r  Uploading to WebODM: {i}/{total}", end="", flush=True)
        if progress and total:
            print()

        self._request("POST", f"/api/projects/{project_id}/tasks/{task_id}/commit/",
                      "start processing (commit)")
        return task_id

    def task_info(self, project_id, task_id):
        return self._request("GET", f"/api/projects/{project_id}/tasks/{task_id}/",
                             "check task status").json()

    def new_console_lines(self, project_id, task_id, from_line=0):
        """New lines of WebODM's processing log since line number 'from_line'.
        We ask only for new lines so we don't re-download the whole log each time."""
        try:
            text = self._request("GET", f"/api/projects/{project_id}/tasks/{task_id}/output/",
                                 "read the processing log",
                                 params={"line": from_line}).json()
        except (WebODMError, ValueError):
            return []
        return text.splitlines() if isinstance(text, str) and text else []

    def wait_for_task(self, project_id, task_id, poll_seconds=10):
        """Check progress every few seconds and draw a progress bar until done.

        If you press Ctrl+C, we stop WATCHING - WebODM keeps PROCESSING.
        Use 'python -m dronepipe resume ...' later to collect the results.
        """
        start = time.time()
        last_line = ""
        log_line_no = 0   # how many log lines we've already seen
        try:
            while True:
                info = self.task_info(project_id, task_id)
                status = info.get("status")
                pct = int((info.get("running_progress") or 0) * 100)
                bar = "#" * (pct // 5) + "-" * (20 - pct // 5)
                elapsed = time.strftime("%H:%M:%S", time.gmtime(time.time() - start))
                new_lines = self.new_console_lines(project_id, task_id, log_line_no)
                log_line_no += len(new_lines)
                non_blank = [ln.strip() for ln in new_lines if ln.strip()]
                if non_blank:
                    last_line = non_blank[-1]
                stage = last_line[:45]
                print(f"\r  [{bar}] {pct:3d}%  {STATUS_NAMES.get(status, 'WAITING'):9s} "
                      f"{elapsed}  {stage:<45}", end="", flush=True)

                if status == COMPLETED:
                    print()
                    return info
                if status in (FAILED, CANCELED):
                    print()
                    raise WebODMError(
                        f"Processing {STATUS_NAMES[status].lower()}: "
                        f"{info.get('last_error') or 'no reason given'}. "
                        "Open the task in WebODM's web page to read the full log.")
                time.sleep(poll_seconds)
        except KeyboardInterrupt:
            print("\n\n  Stopped watching. WebODM is STILL processing in the background.\n"
                  "  When it's finished, collect the results with the 'resume' command "
                  "(see README).")
            raise

    def download(self, project_id, task_id, asset, dest, progress=True):
        """Download one result file in chunks (results can be several GB)."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        resp = self._request("GET", f"/api/projects/{project_id}/tasks/{task_id}/download/{asset}",
                             f"download {asset}", stream=True, timeout=600)
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        # Write to a temporary name first, then rename when complete, so a
        # half-finished download never looks like a real file.
        partial = dest.with_name(dest.name + ".part")
        with open(partial, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
                done += len(chunk)
                if progress:
                    size = f"{done / 1e6:.1f} MB" + (f" of {total / 1e6:.1f} MB" if total else "")
                    print(f"\r    {asset}: {size}    ", end="", flush=True)
        if progress:
            print()
        partial.replace(dest)
        return dest
