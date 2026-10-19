cd /workspace/code
export HF_HOME=/workspace/hf PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
stage() { python3 -c "import json,sys,os;p='/workspace/stage.json';d=json.load(open(p)) if os.path.exists(p) else {};d[sys.argv[1]]=sys.argv[2];json.dump(d,open(p,'w'))" "$1" "$2"; echo "$(date) $1=$2"; }
count() { ps -eo args | grep -E "^/workspace/envs/[a-z0-9]+/bin/python $1" | wc -l; }

stage gen running
rebalanced=0
while [ $(count gen_f5.py) -gt 0 ] || [ $(count gen_cb.py) -gt 0 ]; do
  if [ $rebalanced = 0 ] && [ $(count gen_cb.py) = 0 ]; then
    pkill -f "python gen_f5.py" ; sleep 5
    for s in 0 1 2 3 4 5; do OMP_NUM_THREADS=2 nohup /workspace/envs/indicf5/bin/python gen_f5.py $s 6 >> /workspace/logs/f5_r$s.log 2>&1 & done
    rebalanced=1; echo "$(date) rebalanced f5 to 6 workers"
    sleep 120
  fi
  sleep 30
done
stage gen done

stage filter running
OMP_NUM_THREADS=4 /workspace/envs/train/bin/python filter.py > /workspace/logs/filter.log 2>&1
stage filter done

stage train running
OMP_NUM_THREADS=1 /workspace/envs/train/bin/python train.py run=r1 epochs=5 bs=16 accum=2 gc=1 eval_every=50 > /workspace/logs/train_r1.log 2>&1
OMP_NUM_THREADS=1 /workspace/envs/train/bin/python train.py run=r2 epochs=5 bs=16 accum=2 gc=1 eval_every=50 lr=2e-5 freeze_enc=16 base_eval=0 > /workspace/logs/train_r2.log 2>&1
stage train done
echo "$(date) PIPELINE DONE"
