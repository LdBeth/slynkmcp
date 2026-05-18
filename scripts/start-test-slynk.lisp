;;; Boots an SBCL Slynk listener on port 4006 for swankmcp integration tests.
;;; Run with:  sbcl --non-interactive --load scripts/start-test-slynk.lisp
(load (car (directory #P"~/.emacs.d/elpa/sly-*/slynk/slynk.asd")))
(asdf:load-system :slynk)
(slynk:create-server :port 4006 :dont-close t)
(format t "~&SLYNK-TEST READY~%")
(force-output)
(loop (sleep 60))
